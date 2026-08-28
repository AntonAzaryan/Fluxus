/**
 * Expression Evaluator (EXPR-1..6): чистые вычисления над JSON-AST в форме
 * JsonLogic. Реализация своя, а не `json-logic-js`: её арифметика — встроенные
 * операторы JavaScript над double (мимо DET-2), а расширение через
 * `add_operation` — глобальная мутация синглтона (мимо DI-1). Форма AST при
 * этом сохранена — с ней работает редактор.
 */
import { countCostExpression } from '../debug.js';
import { NO_ENTITY } from '../types.js';
import type {
  EntityId,
  Fixed,
  MathApi,
  RaycastHit,
  RaycastOptions,
  ReadonlyEventLog,
  SystemContext,
  Vec2,
} from '../types.js';

/** Узел AST: литерал либо объект с ровно одним ключом-оператором (EXPR-1). */
export type Expression = number | boolean | string | Readonly<Record<string, unknown>>;

/**
 * Три типа значения выражения и ровно три (EXPR-7): `number`, `bool`, `vec2`.
 * Масштаб `number` — конвенция автора, а не часть типа: `i32`-поля приводятся
 * оператором `fromInt` (EXPR-2). Ширина — не менее 48 бит: `EntityId` ходит по
 * выражениям обычным числом (ECS-6), и 32-битное представление молча испортило
 * бы его. Строкового типа значения нет: строка допустима только литеральным
 * аргументом-именем и не вычисляется.
 */
export type ExprValue = Fixed | boolean | Vec2;

/**
 * Read-only срез `SystemContext`. Sandbox EXPR-3 держится на этом типе:
 * `commands` в выражение не попадает, а шина — только read-only-частью, без
 * `emit`, значит писать выражению нечем.
 */
export type ExprWorld = Pick<
  SystemContext,
  'tick' | 'get' | 'has' | 'isAlive' | 'math' | 'terrain' | 'physics'
> & {
  /** Шина текущего тика (EVT-2); читается оператором `eventField`. */
  readonly events: ReadonlyEventLog;
};

/**
 * Ячейка изменяемой привязки `let` (ACT-4): значение живёт в ней, а не прямо в
 * объекте области видимости. Вложенное тело получает КОПИЮ этого объекта
 * (`{ ...vars }`), поэтому запись в копию наружу не видна — а запись в общую
 * ячейку видна, и именно это делает `let` аккумулятором свёртки.
 *
 * Привязки `as` (`forEach`, `forEachEvent`, `random`, `randomBelow`) остаются
 * голыми значениями: это и есть механическая форма запрета `set` на переменную
 * итерации, поверх статической проверки на регистрации (SYS-3).
 *
 * Класс, а не объект-литерал `{ value }`: `Vec2` — тоже объект, и различать их
 * проверкой по имени поля значило бы гадать по форме, а не знать по типу.
 */
export class ExprCell {
  value: ExprValue;

  constructor(value: ExprValue) {
    this.value = value;
  }
}

/**
 * Локальные переменные: аргументы системы и биндинги `let` из Action DSL.
 * Привязка — либо значение, либо ячейка (ACT-4); `var` разворачивает ячейку при
 * чтении, поэтому разница видна исполнителю действий, но не автору выражения.
 */
export type ExprVars = Readonly<Record<string, ExprValue | ExprCell>>;

/** Точка подмены реализации (EXPR-4). */
export interface ExpressionEvaluator {
  evaluate(expr: Expression, world: ExprWorld, vars?: ExprVars): ExprValue;
}

const NO_VARS: ExprVars = {};

/**
 * Узел-объект выражения. Вход — `unknown`, а не `Expression`, и это не
 * формальность: выражение приезжает документом контента, где законны и `null`,
 * и вложенный массив, а `typeof null === 'object'`. В типе `Expression` их нет,
 * поэтому проверка по типам выглядит лишней — а по данным она обязательна.
 */
function isNode(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

export function evaluate(expr: Expression, world: ExprWorld, vars: ExprVars = NO_VARS): ExprValue {
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (!isNode(expr)) {
    throw new Error(`строка допустима только как аргумент-имя оператора: ${JSON.stringify(expr)}`);
  }
  const keys = Object.keys(expr);
  if (keys.length !== 1) {
    throw new Error(`узел должен содержать ровно один оператор, найдено ${keys.length}: ${JSON.stringify(expr)}`);
  }
  const op = keys[0]!;
  // hasOwn, а не `op in OPS`: иначе `constructor` в позиции оператора
  // разрешился бы через цепочку прототипов (EXPR-6). Разрешение имени и
  // проверка — одним шагом: таблица операторов заполнена этим же модулем, и
  // «нашлось» для неё то же самое, что «объявлено».
  const def = Object.hasOwn(OPS, op) ? OPS[op] : undefined;
  if (def === undefined) throw new Error(`неизвестный оператор "${op}"`);
  const raw = (expr as Record<string, unknown>)[op];
  // Значение-не-список читается как список из одного аргумента — конвенция
  // JsonLogic, на которой держится запись `{"!": {"var": "flag"}}` (EXPR-8).
  const args = (Array.isArray(raw) ? raw : [raw]) as readonly Expression[];
  // Арность проверяется здесь, а не в каждом операторе: одна проверка на узел
  // против сорока одинаковых, и та же таблица служит валидации на регистрации.
  const wrong = arityError(op, def, args.length);
  if (wrong !== undefined) throw new Error(wrong);
  // Единица объёма работы DSL — применение оператора (PERF-3); литералы,
  // вернувшиеся выше, работой не считаются. Вне тика приёмника нет, и учёт не
  // исполняется: вычисление выражения редактором счётчик не двигает.
  countCostExpression();
  return def.fn(args, world, vars);
}

/** Реализация по умолчанию за абстракцией EXPR-4. */
export const evaluator: ExpressionEvaluator = { evaluate };

// --------------------------------------------------------------- сигнатуры

/**
 * Форма применения оператора (EXPR-8): сколько аргументов допустимо, какие
 * позиции заняты литеральными именами и какие числовые литералы ограничены
 * областью определения.
 *
 * Живёт одной таблицей с реализацией (`OPS`), а не второй рядом: валидация на
 * регистрации (SYS-3) читает ту же запись, которую исполняет вычисление, и
 * разойтись им негде — ровно тот же приём, что у обхода аргументов действий по
 * конвенции имён.
 */
export interface OpSignature {
  /** Минимальное число аргументов. */
  readonly min: number;
  /** Максимальное; `Infinity` — верхней границы нет (`and`, `or`, `if`). */
  readonly max: number;
  /** Число аргументов обязано быть нечётным: `if` — это `[cond, then, …, else]`. */
  readonly odd: boolean;
  /** Позиции литеральных имён (EXPR-7); в остальных позициях стоят выражения. */
  readonly literals: readonly number[];
  /**
   * Позиция → допустимый диапазон целого литерала. Проверяется на регистрации
   * (SYS-3); вычисляемый аргумент в той же позиции остаётся ошибкой времени
   * вычисления (SYS-9).
   */
  readonly ranges: readonly (readonly [position: number, lo: number, hi: number])[];
}

/** Диапазон номера бита `bitTest` (EXPR-2): маска читается как 32-битная. */
const BIT_LO = 0;
const BIT_HI = 31;

const NO_LITERALS: readonly number[] = Object.freeze([]);
const NO_RANGES: OpSignature['ranges'] = Object.freeze([]);

/**
 * Сигнатура оператора; `undefined` — имени в таблице нет. `hasOwn`, а не
 * `in`: `constructor` в позиции оператора не должен разрешаться через цепочку
 * прототипов ни при вычислении, ни на регистрации (EXPR-6).
 *
 * Наружу уходит сама строка таблицы, а не её копия, — и потому строка заморожена
 * при сборке (`def`/`defVariadic`). Модуль реэкспортируется из `index.ts`, и без
 * заморозки потребитель дотянулся бы до `fn`: это ровно `add_operation`
 * `json-logic-js` — мутация синглтона, отвергнутая DI-1 и EXPR-6.
 */
export function signatureOf(op: string): OpSignature | undefined {
  return Object.hasOwn(OPS, op) ? OPS[op] : undefined;
}

/**
 * Сообщение об ошибке арности или `undefined`, если число аргументов допустимо.
 * Общее для обеих проверок: на регистрации (SYS-3) и при вычислении.
 */
export function arityError(op: string, signature: OpSignature, count: number): string | undefined {
  if (count >= signature.min && count <= signature.max && (!signature.odd || count % 2 === 1)) {
    return undefined;
  }
  if (signature.min === signature.max) {
    return `оператор "${op}": ожидалось аргументов ${signature.min}, получено ${count}`;
  }
  // Верхняя граница есть только у операторов с необязательным хвостом
  // (raycast-операторы, EXPR-8): «не менее трёх» о них сказало бы неправду.
  if (signature.max !== Infinity) {
    return `оператор "${op}": ожидалось аргументов от ${signature.min} до ${signature.max}, получено ${count}`;
  }
  if (signature.odd) {
    return `оператор "${op}": ожидалось [cond, then, …, else] — нечётное число аргументов не менее ${signature.min}, получено ${count}`;
  }
  return `оператор "${op}": ожидалось аргументов не менее ${signature.min}, получено ${count}`;
}

// --------------------------------------------------- проверки типов (EXPR-7)
//
// Неявных приведений нет ни в одну сторону: число в позиции условия — ошибка
// вычисления, а не «ненулевое истинно» (правило истинности числа в Q16.16
// неоднозначно: `65536` — это `1.0`, а `1` — `0.0000152`), булево в арифметике —
// тоже ошибка, а не `0`/`1`. Сообщение называет оператор и полученный тип
// именами самой модели типов, а не именами типов хоста: `vec2`, а не `object`.

/** Имя типа значения в терминах EXPR-7 — то, что видно в тексте ошибки. */
export function typeNameOf(v: ExprValue): 'number' | 'bool' | 'vec2' {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  return 'vec2';
}

/** Отказ по типу — одной формулировкой на все проверки (EXPR-7). */
export function typeError(where: string, expected: string, got: ExprValue): Error {
  return new Error(`${where}: ожидалось значение типа ${expected}, получено ${typeNameOf(got)}`);
}

function num(v: ExprValue, op: string): Fixed {
  if (typeof v !== 'number') throw typeError(`оператор "${op}"`, 'number', v);
  return v;
}

function bool(v: ExprValue, op: string): boolean {
  if (typeof v !== 'boolean') throw typeError(`оператор "${op}"`, 'bool', v);
  return v;
}

function vec(v: ExprValue, op: string): Vec2 {
  if (typeof v !== 'object') throw typeError(`оператор "${op}"`, 'vec2', v);
  return v;
}

/**
 * `EntityId` — обычное значение типа `number` (EXPR-7), а не Q16.16:
 * масштабировать его нельзя, и усечения до 32 бит на этом пути нет — полный
 * 48-битный идентификатор доживает до предиката живости целым (ECS-6, ID-1).
 */
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

/** Строка таблицы: форма применения (EXPR-8) и реализация — вместе, а не рядом. */
interface OpDef extends OpSignature {
  readonly fn: OpFn;
}

/**
 * Замораживает строку целиком, вместе с вложенными списками: `signatureOf`
 * отдаёт её наружу как есть, и незамороженный `literals` или диапазон был бы той
 * же дырой, что незамороженная строка (см. `signatureOf`).
 */
function freezeRow(row: OpDef): OpDef {
  Object.freeze(row.literals);
  for (const range of row.ranges) Object.freeze(range);
  Object.freeze(row.ranges);
  return Object.freeze(row);
}

/** Оператор с точным числом аргументов. */
function def(n: number, fn: OpFn, rest: Partial<OpSignature> = {}): OpDef {
  return freezeRow({ min: n, max: n, odd: false, literals: NO_LITERALS, ranges: NO_RANGES, ...rest, fn });
}

/** Переменная арность: `and`/`or` (не менее двух) и `if` (нечётное, не менее трёх). */
function defVariadic(min: number, odd: boolean, fn: OpFn): OpDef {
  return freezeRow({ min, max: Infinity, odd, literals: NO_LITERALS, ranges: NO_RANGES, fn });
}

const num1 =
  (op: string, fn: (m: MathApi, a: Fixed) => ExprValue): OpFn =>
  (args, w, v) =>
    fn(w.math, num(evaluate(args[0]!, w, v), op));

const num2 =
  (op: string, fn: (m: MathApi, a: Fixed, b: Fixed) => ExprValue): OpFn =>
  (args, w, v) =>
    fn(w.math, num(evaluate(args[0]!, w, v), op), num(evaluate(args[1]!, w, v), op));

const vec1 =
  (op: string, fn: (m: MathApi, a: Vec2) => ExprValue): OpFn =>
  (args, w, v) =>
    fn(w.math, vec(evaluate(args[0]!, w, v), op));

const vec2 =
  (op: string, fn: (m: MathApi, a: Vec2, b: Vec2) => ExprValue): OpFn =>
  (args, w, v) =>
    fn(w.math, vec(evaluate(args[0]!, w, v), op), vec(evaluate(args[1]!, w, v), op));

/**
 * Общая часть трёх raycast-операторов (EXPR-2, EXPR-8): детерминированный луч
 * Physics API, открытый выражению так же, как `hasFloorAt` открывает запрос
 * террейна. Семантику пересечения, исключение источника, выбор ближайшего
 * попадания и порядок hit'ов задают PHYS-6 и PHYS-7 — здесь только вызов.
 *
 * По лучу на оператор, без кэша: три чтения одного отрезка — три вызова
 * (осознанный размен, выражения чисты и детерминизм от него не страдает).
 *
 * `ignore` тотален: значение, не адресующее живую сущность (в том числе
 * «ссылки нет» `-1`, ECS-6), не совпадает ни с одной сущностью обхода и потому
 * не исключает никого. `mask` — необязательное литеральное имя тега; без него
 * пересечение считается по всем коллайдерам.
 */
const ray =
  (op: string, pick: (hit: RaycastHit | null, to: Vec2) => ExprValue): OpFn =>
  (args, w, v) => {
    const from = vec(evaluate(args[0]!, w, v), op);
    const to = vec(evaluate(args[1]!, w, v), op);
    const ignore = eid(evaluate(args[2]!, w, v), op);
    // Сцена без Physics API — ошибка вычисления, а не «попадания нет» (EXPR-2):
    // то же правило и та же причина, что у `hasFloorAt` без террейна.
    if (w.physics === undefined) throw new Error(`оператор "${op}": сцена без Physics API`);
    const options: RaycastOptions = args.length > 3 ? { mask: str(args[3]!, op), ignore } : { ignore };
    return pick(w.physics.raycast(from, to, options), to);
  };

/** Форма raycast-операторов: 3 или 4 аргумента, последний — литеральное имя тега (EXPR-8). */
const RAY: Partial<OpSignature> = { max: 4, literals: [3] };

/**
 * Равенство только над операндами одного типа (EXPR-8). Разнотипные операнды —
 * ошибка, а не `false`: «не равны» здесь и есть неявное приведение, спрятанное
 * в результате, а его запретил EXPR-7.
 *
 * Два отказа, а не один, и различие между ними — во входе, а не в строгости:
 * «сравнивается не то, что задумано» — это ДВА вектора, у равенства которых своё
 * правило; «сравнивается несравнимое» — операнды разных типов, включая вектор со
 * скаляром. Второй случай идёт общим текстом несовпадения типа (EXPR-7), потому
 * что текст про покомпонентное сравнение описывал бы не тот вход, который пришёл.
 */
const equality =
  (op: string, negate: boolean): OpFn =>
  (args, w, v) => {
    const a = evaluate(args[0]!, w, v);
    const b = evaluate(args[1]!, w, v);
    if (typeof a === 'object' && typeof b === 'object') {
      throw new Error(`оператор "${op}": векторы сравниваются покомпонентно, а не целиком`);
    }
    // Ожидание задаёт первый операнд: он же и решает, с чем сравнение имело
    // смысл. Форма сообщения — та же, что у любого несовпадения типа, чтобы
    // автор читал одну строку, а не вторую формулировку для того же класса.
    if (typeof a !== typeof b) throw typeError(`оператор "${op}"`, typeNameOf(a), b);
    return (a === b) !== negate;
  };

/**
 * Закрытая таблица (EXPR-6), нормированная построчно EXPR-8: имя, арность,
 * литеральные позиции, реализация. Оператора итерации в ней нет и быть не
 * должно: циклы живут только в actions (EXPR-5).
 */
const OPS: Record<string, OpDef> = Object.freeze({
  // окружение
  var: def(
    1,
    (args, _w, v) => {
      const key = str(args[0]!, 'var');
      if (!Object.hasOwn(v, key)) throw new Error(`неизвестная переменная "${key}"`);
      const bound = v[key]!;
      // Ячейка разворачивается при чтении (ACT-4): изменяемость привязки — дело
      // исполнителя действий, а выражение видит обычное значение.
      return bound instanceof ExprCell ? bound.value : bound;
    },
    { literals: [0] },
  ),
  /** Номер тика — сырое целое, для арифметики требует `fromInt`. */
  tick: def(0, (_args, w) => w.tick),
  getComponent: def(
    3,
    (args, w, v) => {
      const entity = eid(evaluate(args[0]!, w, v), 'getComponent');
      return w.get(entity, str(args[1]!, 'getComponent'), str(args[2]!, 'getComponent'));
    },
    { literals: [1, 2] },
  ),
  hasComponent: def(
    2,
    (args, w, v) => w.has(eid(evaluate(args[0]!, w, v), 'hasComponent'), str(args[1]!, 'hasComponent')),
    { literals: [1] },
  ),
  isAlive: def(1, (args, w, v) => w.isAlive(eid(evaluate(args[0]!, w, v), 'isAlive'))),
  /**
   * Наличие пола под мировой позицией (TERR-8). Тотален за краем сетки, как
   * `levelAt` (TERR-4); читает мир, а не отложенные команды, — как
   * `getComponent` и по той же причине (QUERY-3): до flush мир не менялся.
   * Сцена без террейна — ошибка, а не `false`: отсутствие арены и отсутствие
   * пола различимы, и второе значение спрятало бы ошибку сборки сцены.
   */
  hasFloorAt: def(1, (args, w, v) => {
    const position = vec(evaluate(args[0]!, w, v), 'hasFloorAt');
    if (w.terrain === undefined) throw new Error('оператор "hasFloorAt": сцена без террейна');
    return w.terrain.hasFloorAt(position);
  }),
  /** Есть ли попадание на отрезке (EXPR-8); различает статику и пустоту, чего `raycastEntity` не умеет. */
  raycastHit: def(3, ray('raycastHit', (hit) => hit !== null), RAY),
  /**
   * Сущность ближайшего попадания (PHYS-7). Попадание в статический коллайдер
   * и отсутствие попадания — одно и то же значение «ссылки нет» `-1` (ECS-6):
   * различает их `raycastHit`, а сигнального третьего значения в языке нет.
   */
  raycastEntity: def(3, ray('raycastEntity', (hit) => hit?.entity ?? NO_ENTITY), RAY),
  /**
   * Точка ближайшего попадания; без попадания — `to`, дальняя достижимая точка
   * отрезка. Тотальность вместо сигнального значения: у `vec2` его и нет.
   */
  raycastPoint: def(3, ray('raycastPoint', (hit, to) => hit?.point ?? to), RAY),
  /**
   * Поле данных события, на которое ссылается имя, связанное `forEachEvent`
   * (ACT-1). Ссылка — индекс в шине тика, как `EntityId` — непрозрачное число.
   *
   * Масштаб не преобразуется, как и у `getComponent`: что в данных Q16.16, а
   * что сырое целое, знает эмитент (у `Collision` нормаль — Q16.16, `entity` —
   * идентификатор). Отсутствующее поле — ошибка, а не нуль: реестра типов
   * событий нет, поймать опечатку на регистрации нечем (SYS-3).
   */
  eventField: def(
    2,
    (args, w, v) => {
      const event = w.events.at(num(evaluate(args[0]!, w, v), 'eventField'));
      const field = str(args[1]!, 'eventField');
      // `hasOwn`, а не проверка на undefined: иначе `toString` в позиции имени
      // поля дотянулся бы до прототипа хост-объекта (EXPR-6).
      const value = Object.hasOwn(event.data, field) ? event.data[field] : undefined;
      if (typeof value !== 'number') {
        throw new Error(`оператор "eventField": у события "${event.type}" нет поля "${field}"`);
      }
      return value;
    },
    { literals: [1] },
  ),

  // арифметика Q16.16
  '+': def(2, num2('+', (m, a, b) => m.add(a, b))),
  '-': def(2, num2('-', (m, a, b) => m.sub(a, b))),
  '*': def(2, num2('*', (m, a, b) => m.mul(a, b))),
  '/': def(2, num2('/', (m, a, b) => m.div(a, b))),
  min: def(2, num2('min', (m, a, b) => m.min(a, b))),
  max: def(2, num2('max', (m, a, b) => m.max(a, b))),
  abs: def(1, num1('abs', (m, a) => m.abs(a))),
  sqrt: def(1, num1('sqrt', (m, a) => m.sqrt(a))),
  /** Тригонометрия (FP-7): угол — Q16.16-доля оборота, 16384 = 90° (EXPR-2). */
  sin: def(1, num1('sin', (m, a) => m.sin(a))),
  cos: def(1, num1('cos', (m, a) => m.cos(a))),
  /**
   * Порядок сведения нормативен (EXPR-8): при `lo > hi` `min(max(x, lo), hi)`
   * даёт `hi`, а зеркальная запись — `lo`, и выбор реализации разошёлся бы
   * между ядрами.
   */
  clamp: def(3, (args, w, v) =>
    w.math.clamp(
      num(evaluate(args[0]!, w, v), 'clamp'),
      num(evaluate(args[1]!, w, v), 'clamp'),
      num(evaluate(args[2]!, w, v), 'clamp'),
    ),
  ),
  /** Явное приведение масштаба для полей типа `i32` (EXPR-2). */
  fromInt: def(1, num1('fromInt', (m, a) => m.fromInt(a))),
  toInt: def(1, num1('toInt', (m, a) => m.toInt(a))),
  /**
   * Проверка бита маски `i32` — сырое целое, без Q16.16 (EXPR-2). Единственная
   * битовая операция в таблице: маска читается по одному биту, арифметика над
   * ней не определена, а фронт кнопки (TICK-4) иначе в JSON не выразить.
   *
   * Литеральный номер бита до тика не доживает — его отвергает регистрация по
   * `ranges` (SYS-3); проверка ниже остаётся ради вычисляемого (SYS-9).
   */
  bitTest: def(
    2,
    (args, w, v) => {
      const mask = num(evaluate(args[0]!, w, v), 'bitTest');
      const bit = num(evaluate(args[1]!, w, v), 'bitTest');
      if (!Number.isInteger(bit) || bit < BIT_LO || bit > BIT_HI) {
        throw new Error(`оператор "bitTest": номер бита — целое ${BIT_LO}..${BIT_HI}, получено ${bit}`);
      }
      return ((mask >>> bit) & 1) === 1;
    },
    { ranges: [[1, BIT_LO, BIT_HI]] },
  ),

  // сравнения: Q16.16 монотонен, поэтому сравнение обычное числовое
  '<': def(2, num2('<', (_m, a, b) => a < b)),
  '<=': def(2, num2('<=', (_m, a, b) => a <= b)),
  '>': def(2, num2('>', (_m, a, b) => a > b)),
  '>=': def(2, num2('>=', (_m, a, b) => a >= b)),
  '==': def(2, equality('==', false)),
  '!=': def(2, equality('!=', true)),

  // логика: ленивость нормативна (EXPR-8), а не оптимизация — жадная
  // реализация роняла бы матч там, где ленивая работает
  and: defVariadic(2, false, (args, w, v) => args.every((a) => bool(evaluate(a, w, v), 'and'))),
  or: defVariadic(2, false, (args, w, v) => args.some((a) => bool(evaluate(a, w, v), 'or'))),
  '!': def(1, (args, w, v) => !bool(evaluate(args[0]!, w, v), '!')),
  /** `[cond, then, …, else]` — ветвление чистое, к EXPR-5 отношения не имеет. */
  if: defVariadic(3, true, (args, w, v) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (bool(evaluate(args[i]!, w, v), 'if')) return evaluate(args[i + 1]!, w, v);
    }
    return evaluate(args[args.length - 1]!, w, v);
  }),

  // векторы — только через Math API (EXPR-2)
  vec: def(2, num2('vec', (_m, x, y) => ({ x, y }))),
  'vec.add': def(2, vec2('vec.add', (m, a, b) => m.vec.add(a, b))),
  'vec.sub': def(2, vec2('vec.sub', (m, a, b) => m.vec.sub(a, b))),
  'vec.dot': def(2, vec2('vec.dot', (m, a, b) => m.vec.dot(a, b))),
  'vec.length': def(1, vec1('vec.length', (m, a) => m.vec.length(a))),
  'vec.lengthSq': def(1, vec1('vec.lengthSq', (m, a) => m.vec.lengthSq(a))),
  /** Нулевой вектор даёт нулевой, а не насыщенный делением на нулевую длину (EXPR-8, FP-5). */
  'vec.normalize': def(1, vec1('vec.normalize', (m, a) => m.vec.normalize(a))),
  'vec.x': def(1, vec1('vec.x', (_m, a) => a.x)),
  'vec.y': def(1, vec1('vec.y', (_m, a) => a.y)),
  /** Порядок аргументов несимметричен и нормативен: скаляр вторым (EXPR-8). */
  'vec.scale': def(2, (args, w, v) =>
    w.math.vec.scale(
      vec(evaluate(args[0]!, w, v), 'vec.scale'),
      num(evaluate(args[1]!, w, v), 'vec.scale'),
    ),
  ),
});

/** Имена операторов — для валидации AST на регистрации системы (SYS-3, этап 8). */
export const operators: readonly string[] = Object.keys(OPS);
