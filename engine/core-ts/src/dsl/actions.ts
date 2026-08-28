/**
 * Action Executor (ACT-1..3): исполняет JSON-описание действий над
 * `SystemContext`. Форма узла та же, что у выражений — один ключ-действие, — но
 * аргументы именованные: у действия их до шести, половина опциональна, и
 * позиционный массив читался бы как `["Health", null, {…}, null]`.
 *
 * Единственная связь с миром — `ctx.commands` и `ctx.events` (ACT-2, CMD-4):
 * прямых мутаций в таблице действий нет, поэтому сломать детерминизм из
 * редактора нечем.
 */
import { evaluate, ExprCell, typeError, type Expression, type ExprValue, type ExprVars } from './expr.js';
import { distSqCompare } from '../math/fixed.js';
import { requireModifierList } from '../systems/modifiers.js';
import { carveFloor as carveFloorInTerrain } from '../systems/terrain.js';
import { POSITION_COMPONENT } from '../types.js';
import type {
  EntityId,
  Fixed,
  FieldOverrides,
  QuerySpec,
  RngStream,
  SystemContext,
  Vec2,
} from '../types.js';

/** Узел действия: объект с ровно одним ключом-именем действия. */
export type Action = Readonly<Record<string, unknown>>;

/**
 * Исполняет список действий по порядку (ACT-3). `body` — имя аргумента, из
 * которого этот список взят (`do`/`then`/`else`): участвует только в пути до
 * узла, который собирается на выходе из упавшего действия.
 */
export function execute(
  actions: readonly Action[],
  ctx: SystemContext,
  vars: ExprVars = {},
  body?: string,
): void {
  // Индексный цикл: номер узла входит в путь ошибки исполнения (SYS-9) ниже.
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const keys = Object.keys(action);
    if (keys.length !== 1) {
      throw new Error(`узел должен содержать ровно одно действие, найдено ${keys.length}: ${JSON.stringify(action)}`);
    }
    const name = keys[0]!;
    // hasOwn, а не `name in ACTIONS`: то же правило, что для операторов (EXPR-6).
    // Разрешение имени и проверка одним шагом — как у операторов в `expr.ts`.
    const run = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
    if (run === undefined) throw new Error(`неизвестное действие "${name}"`);
    try {
      run(args(action[name], name), ctx, vars);
    } catch (cause) {
      throw atNode(`${body === undefined ? '' : `.${body}`}[${i}].${name}`, cause);
    }
  }
}

// ------------------------------------------------------ ошибки исполнения

/**
 * Ошибка класса 3 (SYS-9) с путём до узла. Путь дописывается сегмент за
 * сегментом на выходе из каждого объемлющего действия, поэтому на успешном пути
 * он не собирается вовсе — строк в теле цикла нет.
 */
export class DslRuntimeError extends Error {
  /** Путь до узла от корня тела системы — та же форма, что на регистрации (SYS-3). */
  readonly path: string;
  /** Причина без пути: сообщение оператора или действия. */
  readonly reason: string;

  constructor(path: string, reason: string, cause: unknown) {
    super(`узел ${path}: ${reason}`, { cause });
    this.name = 'DslRuntimeError';
    this.path = path;
    this.reason = reason;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Приписывает сегмент пути к ошибке, поднимающейся из тела действия. */
function atNode(segment: string, cause: unknown): DslRuntimeError {
  if (cause instanceof DslRuntimeError) {
    return new DslRuntimeError(segment + cause.path, cause.reason, cause);
  }
  return new DslRuntimeError(segment, messageOf(cause), cause);
}

/**
 * Ошибка на границе системы, описанной данными: называет систему, путь до узла
 * и причину (SYS-9). Обрывает тик — мягкого продолжения у класса 3 нет (FP-4).
 */
export function systemError(system: string, cause: unknown): Error {
  const where = cause instanceof DslRuntimeError ? `, узел ${cause.path}` : '';
  const reason = cause instanceof DslRuntimeError ? cause.reason : messageOf(cause);
  return new Error(`система "${system}"${where}: ${reason}`, { cause });
}

// ------------------------------------------------------- чтение аргументов

type Args = Readonly<Record<string, unknown>>;

function args(raw: unknown, action: string): Args {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`действие "${action}": аргументы задаются объектом с именами полей`);
  }
  return raw as Args;
}

function argStr(a: Args, key: string, action: string): string {
  const value = a[key];
  if (typeof value !== 'string') {
    throw new Error(`действие "${action}": "${key}" — строковый литерал, а не выражение`);
  }
  return value;
}

function argExpr(a: Args, key: string, action: string): Expression {
  if (a[key] === undefined) throw new Error(`действие "${action}": не задан "${key}"`);
  return a[key] as Expression;
}

/** Необязательный аргумент-выражение: отсутствие даёт `fallback`, а не ошибку. */
function argNum(a: Args, key: string, action: string, ctx: SystemContext, vars: ExprVars, fallback?: Fixed): Fixed {
  if (a[key] === undefined && fallback !== undefined) return fallback;
  return num(evaluate(argExpr(a, key, action), ctx, vars), action);
}

function argBody(a: Args, key: string, action: string): readonly Action[] {
  const value = a[key];
  if (!Array.isArray(value)) throw new Error(`действие "${action}": "${key}" — список действий`);
  return value as readonly Action[];
}

/** Карта «поле → выражение»; отсутствие эквивалентно пустой карте. */
function argFields(a: Args, key: string, action: string): Readonly<Record<string, Expression>> {
  const value = a[key];
  if (value === undefined) return {};
  return args(value, action) as Readonly<Record<string, Expression>>;
}

// ------------------------------------------------------------- вычисления

/**
 * Значение типа `number` (EXPR-7) — то, что принимают поля компонента, данные
 * события и скалярные аргументы действий. Вектор здесь — ошибка вычисления, а не
 * раскладка по угаданным именам полей: поля скалярны (ECS-3), и разложить вектор
 * автор обязан сам, через `vec.x`/`vec.y` (EXPR-2).
 */
function num(value: ExprValue, action: string): Fixed {
  if (typeof value !== 'number') throw typeError(`действие "${action}"`, 'number', value);
  return value;
}

/** Вектор в позиции, где действие ждёт именно его (`center`, `at`). */
function vecOf(value: ExprValue, action: string, key: string): Vec2 {
  if (typeof value !== 'object') throw typeError(`действие "${action}": "${key}"`, 'vec2', value);
  return value;
}

function entityOf(a: Args, ctx: SystemContext, vars: ExprVars, action: string): EntityId {
  return num(evaluate(argExpr(a, 'entity', action), ctx, vars), action);
}

/**
 * Значения полей в порядке отсортированных имён (ACT-3). Порядок ключей объекта
 * JS зависит от их вида — целочисленные имена всплывают вперёд, — поэтому
 * опорой для детерминизма он служить не может.
 */
function fields(
  map: Readonly<Record<string, Expression>>,
  ctx: SystemContext,
  vars: ExprVars,
  action: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const field of Object.keys(map).sort()) {
    result[field] = num(evaluate(map[field]!, ctx, vars), action);
  }
  return result;
}

function overridesOf(a: Args, ctx: SystemContext, vars: ExprVars): FieldOverrides | undefined {
  const raw = a.overrides;
  if (raw === undefined) return undefined;
  const byComponent = args(raw, 'spawnEntity');
  const result: Record<string, Record<string, number>> = {};
  for (const component of Object.keys(byComponent).sort()) {
    result[component] = fields(
      args(byComponent[component], 'spawnEntity') as Readonly<Record<string, Expression>>,
      ctx,
      vars,
      'spawnEntity',
    );
  }
  return result;
}

/** Фильтры запроса — литералы, но центр и радиус `withinRadius` считаются выражениями. */
function querySpec(raw: unknown, ctx: SystemContext, vars: ExprVars): QuerySpec {
  const q = args(raw, 'forEach');
  const names = (key: string): readonly string[] | undefined => {
    const value = q[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((n) => typeof n !== 'string')) {
      throw new Error(`действие "forEach": "${key}" — список имён компонентов`);
    }
    return value as readonly string[];
  };

  let withinRadius: { center: Vec2; radius: Fixed } | undefined;
  if (q.withinRadius !== undefined) {
    const spec = args(q.withinRadius, 'forEach');
    const center = vecOf(evaluate(argExpr(spec, 'center', 'forEach'), ctx, vars), 'forEach', 'center');
    withinRadius = { center, radius: num(evaluate(argExpr(spec, 'radius', 'forEach'), ctx, vars), 'forEach') };
  }

  return {
    all: names('all'),
    any: names('any'),
    not: names('not'),
    withTag: q.withTag === undefined ? undefined : argStr(q, 'withTag', 'forEach'),
    withinRadius,
  };
}

// ------------------------------------------ упорядоченная выборка (ACT-5)

/**
 * Буфер упорядоченной выборки: идентификатор сущности и смещение от `nearestTo`
 * рядом. `Float64Array` под id — `EntityId` 48-битный (ID-1); `Int32Array` под
 * смещения — это координаты Q16.16, то есть `i32` (FP-1).
 *
 * Хранится смещение, а не готовый ключ: квадрат расстояния в Q16.16 не
 * помещается, и сравниваются они точной 64-битной арифметикой по паре
 * смещений (`distSqCompare`) — той же, что решает `withinRadius`.
 */
interface OrderedBuffer {
  readonly ids: Float64Array;
  readonly dx: Int32Array;
  readonly dy: Int32Array;
}

/**
 * Буферы — по одному на уровень вложенности `forEach`: внешний обход идёт по
 * своему буферу, пока тело исполняет внутренний, и один буфер на всех испортил
 * бы внешний. Живут в модуле, а не на инстансе системы: исполнитель — функция,
 * инстанса у него нет. Состоянием симуляции они при этом не становятся: наружу
 * буфер не отдаётся и целиком перезаписывается перед каждым обходом, поэтому в
 * снапшот попасть ему нечем (SNAP-1).
 *
 * Растут до наибольшей встреченной выборки и переиспользуются — аллокации,
 * пропорциональной числу сущностей, на каждый тик нет.
 */
const orderedBuffers: OrderedBuffer[] = [];
let orderedDepth = 0;

function orderedBuffer(size: number): OrderedBuffer {
  const existing = orderedBuffers[orderedDepth];
  if (existing !== undefined && existing.ids.length >= size) return existing;
  const grown: OrderedBuffer = {
    ids: new Float64Array(size),
    dx: new Int32Array(size),
    dy: new Int32Array(size),
  };
  orderedBuffers[orderedDepth] = grown;
  return grown;
}

/** Позиция сущности читается тотально (ECS-7): без компонента — мировое начало координат. */
function positionOf(ctx: SystemContext, entity: EntityId, axis: 'x' | 'y'): Fixed {
  return ctx.has(entity, POSITION_COMPONENT) ? ctx.get(entity, POSITION_COMPONENT, axis) : 0;
}

/**
 * Выборка, упорядоченная по возрастанию квадрата расстояния до `center`
 * (ACT-5). Расстояние — той же арифметикой квадратов и до той же позиции, что
 * у `withinRadius` (QUERY-1): смещение считается через Math API (FP-4), как у
 * арены, а квадраты сравниваются точной 64-битной `distSqCompare` — приближения
 * Q16.16 здесь нет, и предела дальности у порядка тоже.
 *
 * Сортировка вставками, а не `Array.prototype.sort`: порядок сравнений и
 * устойчивость заданы здесь алгоритмом, а не реализацией JS-движка, — то, чего
 * требует нормативный тай-брейк для парности со второй реализацией ядра.
 *
 * Тай-брейк равных квадратов — порядок QUERY-2, и отдельного ключа он не
 * требует: вход отдан запросом по возрастанию raw-индекса, а вставка сдвигает
 * только строго большие ключи, поэтому равные остаются во входном порядке.
 */
function nearestByDistance(ctx: SystemContext, found: Float64Array, center: Vec2): Float64Array {
  const { ids, dx, dy } = orderedBuffer(found.length);
  for (let i = 0; i < found.length; i++) {
    const entity = found[i]!;
    const keyX = ctx.math.sub(positionOf(ctx, entity, 'x'), center.x);
    const keyY = ctx.math.sub(positionOf(ctx, entity, 'y'), center.y);
    let j = i - 1;
    while (j >= 0 && distSqCompare(dx[j]!, dy[j]!, keyX, keyY) > 0) {
      dx[j + 1] = dx[j]!;
      dy[j + 1] = dy[j]!;
      ids[j + 1] = ids[j]!;
      j--;
    }
    dx[j + 1] = keyX;
    dy[j + 1] = keyY;
    ids[j + 1] = entity;
  }
  return ids;
}

/**
 * `limit` — выражение в Q16.16, приводимое к целому внутри действия, как
 * `bound` у `randomBelow`. Отрицательное значение — ошибка вычисления (SYS-9):
 * отрицательного числа целей не бывает, и молчаливый пустой обход спрятал бы
 * дефект формулы. Нулевое — пустой обход, а не ошибка: «не больше нуля целей» —
 * валидная граница политики, в отличие от пустого диапазона `randomBelow`.
 */
function limitOf(a: Args, ctx: SystemContext, vars: ExprVars, count: number): number {
  if (a.limit === undefined) return count;
  const limit = ctx.math.toInt(num(evaluate(a.limit as Expression, ctx, vars), 'forEach'));
  if (limit < 0) {
    throw new Error(`действие "forEach": "limit" не может быть отрицательным, получено ${limit}`);
  }
  return Math.min(limit, count);
}

/**
 * Общая часть `random` и `randomBelow`: стрим системы либо её суб-стрим
 * (RNG-4, RNG-7), значение — в тело как обычная переменная.
 */
function bindRandom(
  a: Args,
  ctx: SystemContext,
  vars: ExprVars,
  action: string,
  draw: (stream: RngStream) => number,
): void {
  const as = argStr(a, 'as', action);
  const sub = a.subStream;
  const stream = sub === undefined ? ctx.rng.stream() : ctx.rng.stream(argStr(a, 'subStream', action));
  execute(argBody(a, 'do', action), ctx, { ...vars, [as]: draw(stream) }, 'do');
}

// --------------------------------------------------------------- действия

/**
 * Имя компонента твина (TWEEN-1). Живёт здесь, а не в `systems/tween.ts`:
 * `addTween` — единственный способ его создать (TWEEN-5), а `TweenSystem` уже
 * зависит от этого модуля ради `execute` для `onComplete` (TWEEN-4), и обратный
 * импорт замкнул бы цикл.
 */
export const TWEEN_COMPONENT = 'Tween';

type ActionFn = (a: Args, ctx: SystemContext, vars: ExprVars) => void;

const ACTIONS: Record<string, ActionFn> = {
  modifyComponent: (a, ctx, vars) => {
    const entity = entityOf(a, ctx, vars, 'modifyComponent');
    const component = argStr(a, 'component', 'modifyComponent');
    const values = fields(argFields(a, 'values', 'modifyComponent'), ctx, vars, 'modifyComponent');
    // Ключи сортируются повторно, а не берутся перечислением уже
    // отсортированной карты: собранный объект носителем порядка быть не может —
    // целочисленные имена в нём всплывают вперёд и упорядочиваются численно
    // (`"9"` до `"10"`), что расходится с ACT-3.
    for (const field of Object.keys(values).sort()) {
      ctx.commands.setField(entity, component, field, values[field]!);
    }
  },
  addComponent: (a, ctx, vars) => {
    ctx.commands.addComponent(
      entityOf(a, ctx, vars, 'addComponent'),
      argStr(a, 'component', 'addComponent'),
      fields(argFields(a, 'values', 'addComponent'), ctx, vars, 'addComponent'),
    );
  },
  removeComponent: (a, ctx, vars) => {
    ctx.commands.removeComponent(
      entityOf(a, ctx, vars, 'removeComponent'),
      argStr(a, 'component', 'removeComponent'),
    );
  },
  spawnEntity: (a, ctx, vars) => {
    ctx.commands.spawn(argStr(a, 'prefab', 'spawnEntity'), overridesOf(a, ctx, vars));
  },
  destroyEntity: (a, ctx, vars) => {
    ctx.commands.destroy(entityOf(a, ctx, vars, 'destroyEntity'));
  },
  emitEvent: (a, ctx, vars) => {
    ctx.events.emit(
      argStr(a, 'type', 'emitEvent'),
      fields(argFields(a, 'data', 'emitEvent'), ctx, vars, 'emitEvent'),
    );
  },
  /**
   * Создание твина (TWEEN-5): обычная команда добавления компонента, прямого
   * пути в обход буфера нет. `def` — индекс в таблице определений сцены
   * (`TweenDef`), потому что путь к полю и `onComplete` в скалярные поля
   * компонента не помещаются (ECS-3); подробнее — в шапке `systems/tween.ts`.
   *
   * `def`, `easing` и `ignoreTimeScale` — поля `i32`, то есть сырые целые, а не
   * Q16.16: та же конвенция, что у `modifyComponent`, преобразований действие
   * не делает.
   */
  addTween: (a, ctx, vars) => {
    ctx.commands.addComponent(entityOf(a, ctx, vars, 'addTween'), TWEEN_COMPONENT, {
      def: argNum(a, 'def', 'addTween', ctx, vars),
      from: argNum(a, 'from', 'addTween', ctx, vars),
      to: argNum(a, 'to', 'addTween', ctx, vars),
      duration: argNum(a, 'duration', 'addTween', ctx, vars),
      elapsed: 0,
      easing: argNum(a, 'easing', 'addTween', ctx, vars, 0),
      ignoreTimeScale: argNum(a, 'ignoreTimeScale', 'addTween', ctx, vars, 0),
    });
  },
  /**
   * Постановка источника-модификатора (TIME-7, TIME-8): `component` адресует
   * список источников, подключённый сценой, `id` — сырое целое (поле `i32`),
   * `value` — множитель в Q16.16. Мутаций мимо буфера нет: слот занимается
   * командами `setField` внутри списка (ACT-2, CMD-4).
   *
   * Два `addModifier` подряд для одной сущности занимают разные слоты: список
   * читает уже поставленные им команды буфера (CMD-5).
   */
  addModifier: (a, ctx, vars) => {
    requireModifierList(ctx.modifiers, argStr(a, 'component', 'addModifier')).add(
      ctx,
      entityOf(a, ctx, vars, 'addModifier'),
      argNum(a, 'id', 'addModifier', ctx, vars),
      argNum(a, 'value', 'addModifier', ctx, vars),
    );
  },
  /**
   * Снятие пола арены в области вокруг мировой позиции (TERR-8). Действие, а не
   * работа контента со словами карты: раскладка нормирована ради побитовой
   * парности реализаций (TERR-6), и адресовать её из данных нечем — битовой
   * арифметики в DSL нет (EXPR-2).
   *
   * `radius` — расстояние в Q16.16, как координаты, а не число клеток: понятия
   * клетки в языке систем нет. Отсутствие радиуса означает одну клетку под
   * точкой, поэтому оно и отличимо от нуля — `argNum` здесь не годится.
   */
  carveFloor: (a, ctx, vars) => {
    const at = vecOf(evaluate(argExpr(a, 'at', 'carveFloor'), ctx, vars), 'carveFloor', 'at');
    const radius =
      a.radius === undefined
        ? undefined
        : num(evaluate(a.radius as Expression, ctx, vars), 'carveFloor');
    carveFloorInTerrain(ctx, at, radius);
  },
  /** Снятие источника по `id` (TIME-8); отсутствующий id — не ошибка. */
  removeModifier: (a, ctx, vars) => {
    requireModifierList(ctx.modifiers, argStr(a, 'component', 'removeModifier')).remove(
      ctx,
      entityOf(a, ctx, vars, 'removeModifier'),
      argNum(a, 'id', 'removeModifier', ctx, vars),
    );
  },
  /**
   * `cond` требует `bool` строго (EXPR-7): числа в позиции условия нет, и
   * проверка флагового поля пишется явным сравнением с нулём (ECS-3, FOW-3).
   */
  if: (a, ctx, vars) => {
    const cond = evaluate(argExpr(a, 'cond', 'if'), ctx, vars);
    if (typeof cond !== 'boolean') throw typeError('действие "if": "cond"', 'bool', cond);
    const branch = cond ? argBody(a, 'then', 'if') : a.else === undefined ? [] : argBody(a, 'else', 'if');
    execute(branch, ctx, vars, cond ? 'then' : 'else');
  },
  /**
   * Биндинги вычисляются во внешней области — параллельно, а не по цепочке:
   * иначе результат зависел бы от порядка имён.
   *
   * Каждое имя связывается ЯЧЕЙКОЙ (ACT-4): вложенное тело получает копию
   * объекта области видимости, но ту же ячейку, поэтому `set` из него виден
   * после выхода — и `let` работает аккумулятором свёртки. Затенение при этом
   * цело: внутренний `let` кладёт в свою копию новую ячейку, а внешняя остаётся
   * нетронутой.
   *
   * ponytail: ячейка — аллокация на исполнение биндинга, то есть внутри тела
   * `forEach` она пропорциональна числу сущностей. Она стоит рядом с копией
   * самого объекта области видимости, которая была здесь и раньше: убирать их
   * имеет смысл только вместе — пулом областей видимости, — и по профилю на
   * реальной сцене, а не по вкусу.
   */
  let: (a, ctx, vars) => {
    const bindings = argFields(a, 'bindings', 'let');
    const scope: Record<string, ExprValue | ExprCell> = { ...vars };
    for (const key of Object.keys(bindings).sort()) {
      scope[key] = new ExprCell(evaluate(bindings[key]!, ctx, vars));
    }
    execute(argBody(a, 'do', 'let'), ctx, scope, 'do');
  },
  /**
   * Присваивание изменяемой привязке `let` (ACT-4). Ячейку даёт ближайший
   * объемлющий `let`, связавший имя: у более внешнего своя, и до неё
   * присваивание не доходит — область видимости перекрыта.
   *
   * Обе ошибки ниже до тика не доживают — их отвергает регистрация системы
   * (SYS-3); проверки здесь последний рубеж, а не рабочий способ их найти.
   */
  set: (a, ctx, vars) => {
    const name = argStr(a, 'name', 'set');
    const value = evaluate(argExpr(a, 'value', 'set'), ctx, vars);
    if (!Object.hasOwn(vars, name)) throw new Error(`действие "set": неизвестная переменная "${name}"`);
    const bound = vars[name]!;
    if (!(bound instanceof ExprCell)) {
      throw new Error(`действие "set": переменная "${name}" связана не действием let и неизменяема`);
    }
    bound.value = value;
  },
  /**
   * Значение стрима, связанное с именем в теле (RNG-6). Действие, а не
   * оператор: продвижение генератора — эффект, а число обращений к нему должно
   * читаться из текста системы, а не зависеть от того, какие ветки выражения
   * вычислялись.
   */
  random: (a, ctx, vars) => {
    bindRandom(a, ctx, vars, 'random', (stream) => stream.nextFixed());
  },
  /**
   * Равномерное целое в `[0, bound)` — отдельным именем, а не полем `kind`:
   * набор имён закрыт и проверяется на регистрации (SYS-3). Остаток от
   * `random` дал бы смещение на границах, которое в эталоне не видно.
   */
  randomBelow: (a, ctx, vars) => {
    const bound = ctx.math.toInt(num(evaluate(argExpr(a, 'bound', 'randomBelow'), ctx, vars), 'randomBelow'));
    if (bound < 1) throw new Error(`действие "randomBelow": "bound" должен быть не меньше 1, получено ${bound}`);
    bindRandom(a, ctx, vars, 'randomBelow', (stream) => stream.nextBelow(bound));
  },
  /**
   * Аргументы читаются в порядке ACT-1 (`query`, `nearestTo`, `limit`): все три
   * вычисляются во внешней области до обхода, и порядок между ними наблюдаем
   * ошибкой вычисления, а не результатом.
   *
   * Результат материализован на момент вызова (QUERY-3), а мутации отложены до
   * flush (CMD-1) — итерация стабильна независимо от тела.
   */
  forEach: (a, ctx, vars) => {
    const as = argStr(a, 'as', 'forEach');
    const body = argBody(a, 'do', 'forEach');
    const found = ctx.query(querySpec(a.query, ctx, vars));
    const nearestTo =
      a.nearestTo === undefined
        ? undefined
        : vecOf(evaluate(a.nearestTo as Expression, ctx, vars), 'forEach', 'nearestTo');
    const limit = limitOf(a, ctx, vars, found.length);
    // Без `nearestTo` упорядочивать нечего: обход идёт порядком QUERY-2, и
    // `limit` лишь обрывает его — буфер сортировки не нужен вовсе (ACT-5).
    const order = nearestTo === undefined ? found : nearestByDistance(ctx, found, nearestTo);
    orderedDepth += nearestTo === undefined ? 0 : 1;
    try {
      for (let i = 0; i < limit; i++) {
        execute(body, ctx, { ...vars, [as]: order[i]! }, 'do');
      }
    } finally {
      orderedDepth -= nearestTo === undefined ? 0 : 1;
    }
  },
  /**
   * Итерация по событиям тика заданного типа (EVT-2). В тело уходит ссылка на
   * событие — индекс в шине, — а поля читаются оператором `eventField`
   * (EXPR-2): значение переменной DSL — скаляр или вектор, карта полей в него
   * не помещается.
   *
   * Длина берётся один раз до обхода — по тому же правилу, что у `forEach` над
   * запросом (QUERY-3): иначе тело, эмитящее событие того же типа, растило бы
   * обход изнутри и зацикливалось.
   */
  forEachEvent: (a, ctx, vars) => {
    const type = argStr(a, 'type', 'forEachEvent');
    const as = argStr(a, 'as', 'forEachEvent');
    const body = argBody(a, 'do', 'forEachEvent');
    const published = ctx.events.length;
    for (let i = 0; i < published; i++) {
      if (ctx.events.at(i).type !== type) continue;
      execute(body, ctx, { ...vars, [as]: i }, 'do');
    }
  },
};

/** Имена действий — для валидации дерева на регистрации системы (SYS-3, этап 8). */
export const actionNames: readonly string[] = Object.keys(ACTIONS);

/**
 * Обязательные аргументы каждого действия (ACT-1) — то, без чего исполнитель
 * бросил бы: `argExpr`, `argStr` и `argBody` отсутствия не прощают. Читается
 * валидацией на регистрации (SYS-3): состав аргументов виден из текста системы
 * целиком, и ждать срабатывания ветки незачем.
 *
 * Перечень живёт здесь, рядом с самой таблицей действий и её чтецами аргументов,
 * и связан с ними тестами: `actions.test.ts` собирает по нему полный набор
 * аргументов и требует, чтобы исполнителя он устраивал, а без любого одного
 * ключа — нет; `evaluatedSystem.test.ts` держит рядом копию, выписанную по
 * ACT-1. Разъехаться перечню, норме и исполнителю негде.
 *
 * Необязательного здесь нет по определению: `argNum` с умолчанием (`easing`,
 * `ignoreTimeScale`), `argFields` (`values`, `data`, `bindings`, `overrides`) и
 * читаемые напрямую `radius`, `else`, `subStream` отсутствие переживают.
 */
export const requiredArgs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  modifyComponent: Object.freeze(['entity', 'component']),
  addComponent: Object.freeze(['entity', 'component']),
  removeComponent: Object.freeze(['entity', 'component']),
  spawnEntity: Object.freeze(['prefab']),
  destroyEntity: Object.freeze(['entity']),
  emitEvent: Object.freeze(['type']),
  addTween: Object.freeze(['entity', 'def', 'from', 'to', 'duration']),
  addModifier: Object.freeze(['entity', 'component', 'id', 'value']),
  removeModifier: Object.freeze(['entity', 'component', 'id']),
  carveFloor: Object.freeze(['at']),
  if: Object.freeze(['cond', 'then']),
  let: Object.freeze(['do']),
  set: Object.freeze(['name', 'value']),
  random: Object.freeze(['as', 'do']),
  randomBelow: Object.freeze(['as', 'bound', 'do']),
  forEach: Object.freeze(['query', 'as', 'do']),
  forEachEvent: Object.freeze(['type', 'as', 'do']),
});
