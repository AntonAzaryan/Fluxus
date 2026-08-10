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
import { carveFloor as carveFloorInTerrain } from '../systems/terrain.js';
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
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const keys = Object.keys(action);
    if (keys.length !== 1) {
      throw new Error(`узел должен содержать ровно одно действие, найдено ${keys.length}: ${JSON.stringify(action)}`);
    }
    const name = keys[0]!;
    // hasOwn, а не `name in ACTIONS`: то же правило, что для операторов (EXPR-6).
    if (!Object.hasOwn(ACTIONS, name)) throw new Error(`неизвестное действие "${name}"`);
    try {
      ACTIONS[name]!(args(action[name], name), ctx, vars);
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
    const center = evaluate(argExpr(spec, 'center', 'forEach'), ctx, vars);
    if (typeof center !== 'object') throw new Error('действие "forEach": "center" — вектор');
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
    const at = evaluate(argExpr(a, 'at', 'carveFloor'), ctx, vars);
    if (typeof at !== 'object') throw new Error('действие "carveFloor": "at" — вектор');
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
  if: (a, ctx, vars) => {
    const cond = evaluate(argExpr(a, 'cond', 'if'), ctx, vars);
    if (typeof cond !== 'boolean') throw new Error(`действие "if": условие должно быть булевым, получено ${typeof cond}`);
    const branch = cond ? argBody(a, 'then', 'if') : a.else === undefined ? [] : argBody(a, 'else', 'if');
    execute(branch, ctx, vars, cond ? 'then' : 'else');
  },
  /** Биндинги вычисляются во внешней области — параллельно, а не по цепочке: иначе результат зависел бы от порядка имён. */
  let: (a, ctx, vars) => {
    const bindings = argFields(a, 'bindings', 'let');
    const scope: Record<string, ExprValue> = { ...vars };
    for (const key of Object.keys(bindings).sort()) {
      scope[key] = evaluate(bindings[key]!, ctx, vars);
    }
    execute(argBody(a, 'do', 'let'), ctx, scope, 'do');
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
    for (const entity of ctx.query(querySpec(a.query, ctx, vars))) {
      execute(body, ctx, { ...vars, [as]: entity }, 'do');
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
  random: Object.freeze(['as', 'do']),
  randomBelow: Object.freeze(['as', 'bound', 'do']),
  forEach: Object.freeze(['query', 'as', 'do']),
  forEachEvent: Object.freeze(['type', 'as', 'do']),
});
