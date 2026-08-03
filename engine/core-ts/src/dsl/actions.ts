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
import { evaluate, type Expression, type ExprValue, type ExprVars } from './expr.js';
import { requireModifierList } from '../systems/modifiers.js';
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

/** Исполняет список действий по порядку (ACT-3). */
export function execute(actions: readonly Action[], ctx: SystemContext, vars: ExprVars = {}): void {
  for (const action of actions) {
    const keys = Object.keys(action);
    if (keys.length !== 1) {
      throw new Error(`узел должен содержать ровно одно действие, найдено ${keys.length}: ${JSON.stringify(action)}`);
    }
    const name = keys[0]!;
    // hasOwn, а не `name in ACTIONS`: то же правило, что для операторов (EXPR-6).
    if (!Object.hasOwn(ACTIONS, name)) throw new Error(`неизвестное действие "${name}"`);
    ACTIONS[name]!(args(action[name], name), ctx, vars);
  }
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

function num(value: ExprValue, action: string): Fixed {
  if (typeof value !== 'number') throw new Error(`действие "${action}": ожидалось число, получено ${typeof value}`);
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
  const raw = a['overrides'];
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
  if (q['withinRadius'] !== undefined) {
    const spec = args(q['withinRadius'], 'forEach');
    const center = evaluate(argExpr(spec, 'center', 'forEach'), ctx, vars);
    if (typeof center !== 'object') throw new Error('действие "forEach": "center" — вектор');
    withinRadius = { center, radius: num(evaluate(argExpr(spec, 'radius', 'forEach'), ctx, vars), 'forEach') };
  }

  return {
    all: names('all'),
    any: names('any'),
    not: names('not'),
    withTag: q['withTag'] === undefined ? undefined : argStr(q, 'withTag', 'forEach'),
    withinRadius,
  };
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
  const sub = a['subStream'];
  const stream = sub === undefined ? ctx.rng.stream() : ctx.rng.stream(argStr(a, 'subStream', action));
  execute(argBody(a, 'do', action), ctx, { ...vars, [as]: draw(stream) });
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
    for (const [field, value] of Object.entries(values)) {
      ctx.commands.setField(entity, component, field, value);
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
  /** Снятие источника по `id` (TIME-8); отсутствующий id — не ошибка. */
  removeModifier: (a, ctx, vars) => {
    requireModifierList(ctx.modifiers, argStr(a, 'component', 'removeModifier')).remove(
      ctx,
      entityOf(a, ctx, vars, 'removeModifier'),
      argNum(a, 'id', 'removeModifier', ctx, vars),
    );
  },
  if: (a, ctx, vars) => {
    const cond = evaluate(argExpr(a, 'cond', 'if'), ctx, vars);
    if (typeof cond !== 'boolean') throw new Error(`действие "if": условие должно быть булевым, получено ${typeof cond}`);
    const branch = cond ? argBody(a, 'then', 'if') : a['else'] === undefined ? [] : argBody(a, 'else', 'if');
    execute(branch, ctx, vars);
  },
  /** Биндинги вычисляются во внешней области — параллельно, а не по цепочке: иначе результат зависел бы от порядка имён. */
  let: (a, ctx, vars) => {
    const bindings = argFields(a, 'bindings', 'let');
    const scope: Record<string, ExprValue> = { ...vars };
    for (const key of Object.keys(bindings).sort()) {
      scope[key] = evaluate(bindings[key]!, ctx, vars);
    }
    execute(argBody(a, 'do', 'let'), ctx, scope);
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
  forEach: (a, ctx, vars) => {
    const as = argStr(a, 'as', 'forEach');
    const body = argBody(a, 'do', 'forEach');
    // Результат материализован на момент вызова (QUERY-3), а мутации отложены
    // до flush (CMD-1) — итерация стабильна независимо от тела.
    for (const entity of ctx.query(querySpec(a['query'], ctx, vars))) {
      execute(body, ctx, { ...vars, [as]: entity });
    }
  },
};

/** Имена действий — для валидации дерева на регистрации системы (SYS-3, этап 8). */
export const actionNames: readonly string[] = Object.keys(ACTIONS);
