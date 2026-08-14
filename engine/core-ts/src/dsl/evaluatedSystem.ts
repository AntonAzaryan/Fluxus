/**
 * JSON-система (SYS-1) и её валидация на регистрации (SYS-3).
 *
 * Для scheduler'а неотличима от системы на TS: тот же интерфейс `System`, то же
 * чтение через контекст и запись через Command Buffer (SYS-4, SYS-6). Именно
 * это делает `override` (SYS-7) безопасным — переписывание системы в код не
 * меняет ничего вокруг.
 */
import { execute, actionNames, requiredArgs, systemError, type Action } from './actions.js';
import { arityError, signatureOf, type Expression } from './expr.js';
import { componentSchema, prefabOf } from '../ecs/world.js';
import type { System, SystemContext, WorldState } from '../types.js';

/** JSON-описание системы. `query` — сахар над действием `forEach` (SYS-1). */
export interface SystemDef {
  readonly name: string;
  readonly order: number;
  readonly query?: unknown;
  /** Имя переменной итерации; по умолчанию `entity`. */
  readonly as?: string;
  readonly do: readonly Action[];
}

const DEFAULT_AS = 'entity';

/**
 * Проверка «это список действий» отдельным предикатом, а не голым
 * `Array.isArray`: система приезжает из JSON, где `do` может оказаться чем
 * угодно, а `Array.isArray` на объявленном типе сужает к `any[]` — то есть
 * ровно там, где мы проверяем недоверенные данные, типы бы и отключились.
 */
function isActionList(value: unknown): value is readonly Action[] {
  return Array.isArray(value);
}

/**
 * Разворачивает `query` в одно действие `forEach`. Отдельного механизма
 * итерации у системы нет намеренно: два цикла с разной семантикой области
 * видимости — лишний способ ошибиться.
 */
function bodyOf(def: SystemDef): readonly Action[] {
  if (!isActionList(def.do)) throw new Error(`система "${def.name}": "do" — список действий`);
  if (def.query === undefined) return def.do;
  return [{ forEach: { query: def.query, as: def.as ?? DEFAULT_AS, do: def.do } }];
}

export class EvaluatedSystem implements System {
  readonly name: string;
  readonly order: number;
  private readonly body: readonly Action[];

  constructor(def: SystemDef) {
    if (typeof def.name !== 'string' || def.name === '') throw new Error('система: "name" — непустая строка');
    if (!Number.isInteger(def.order)) throw new Error(`система "${def.name}": "order" — целое число`);
    this.name = def.name;
    this.order = def.order;
    this.body = bodyOf(def);
  }

  run(ctx: SystemContext): void {
    try {
      execute(this.body, ctx);
    } catch (cause) {
      // Класс 3 (SYS-9): сообщение называет систему, путь до узла и причину.
      // Ошибка жёсткая — она обрывает тик, и команды, накопленные этой системой
      // до обрыва, до мира не доходят: их сливает `tick()` после `run`.
      throw systemError(this.name, cause);
    }
  }
}

// ------------------------------------------------------------- валидация

/**
 * Вид связывания имени. Различается ради `set`: присваивать можно только тому,
 * что связано `bindings` действия `let` (ACT-4), а переменная итерации `as`
 * неизменяема — и вид известен статически, поэтому вердикт выносится здесь, а
 * не на первом срабатывании ветки.
 */
type BindingKind = 'let' | 'as';

/** Область видимости на регистрации: имя → чем оно связано. */
type Scope = ReadonlyMap<string, BindingKind>;

/**
 * Проверяет дерево до старта матча (SYS-3). `bound` — имена, считающиеся
 * связанными снаружи: сейчас пусто, параметр под входные параметры систем
 * (этап 9). Внешнее имя неизменяемо — параметр системы не привязка `let`.
 */
export function validateSystem(def: SystemDef, world: WorldState, bound: readonly string[] = []): void {
  const scope = new Map<string, BindingKind>(bound.map((name) => [name, 'as']));
  checkActions(bodyOf(def), world, scope, `система "${def.name}"`);
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

/** Общая для обоих DSL форма: объект с ровно одним ключом. */
function onlyKey(node: unknown, path: string, kind: string): [string, unknown] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    fail(path, `ожидался ${kind} — объект с одним ключом`);
  }
  const keys = Object.keys(node);
  if (keys.length !== 1) fail(path, `${kind} должен содержать ровно один ключ, найдено ${keys.length}`);
  const key = keys[0]!;
  return [key, (node as Record<string, unknown>)[key]];
}

function asMap(node: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) fail(path, 'ожидался объект');
  return node as Readonly<Record<string, unknown>>;
}

function literal(node: unknown, path: string): string {
  if (typeof node !== 'string') fail(path, 'ожидался строковый литерал');
  return node;
}

function checkActions(list: unknown, world: WorldState, scope: Scope, path: string): void {
  if (!Array.isArray(list)) fail(path, 'ожидался список действий');
  list.forEach((node, i) => { checkAction(node, world, scope, `${path}[${i}]`); });
}

/**
 * Обход опирается на конвенцию имён аргументов, единую для всего Action DSL
 * (SYS-3), а не на вторую таблицу рядом с таблицей действий: таблица-дубль
 * рассинхронизировалась бы с оригиналом при первом же новом действии.
 */
function checkAction(node: unknown, world: WorldState, scope: Scope, path: string): void {
  const [name, rawArgs] = onlyKey(node, path, 'действие');
  if (!actionNames.includes(name)) fail(path, `неизвестное действие "${name}"`);
  const here = `${path}.${name}`;
  const args = asMap(rawArgs, here);

  // Имена, введённые этим действием, видны только его телу; `bindings` при
  // этом вычисляются снаружи (параллельное связывание, см. ACT-1). Вид
  // связывания запоминается вместе с именем — по нему решается `set` (ACT-4).
  const inner = new Map(scope);
  if (args.as !== undefined) inner.set(literal(args.as, `${here}.as`), 'as');
  if (args.bindings !== undefined) {
    for (const key of Object.keys(asMap(args.bindings, `${here}.bindings`))) inner.set(key, 'let');
  }

  const component = args.component === undefined ? undefined : literal(args.component, `${here}.component`);
  if (component !== undefined && componentSchema(world, component) === undefined) {
    fail(`${here}.component`, `компонент "${component}" не зарегистрирован`);
  }

  for (const [key, value] of Object.entries(args)) {
    const at = `${here}.${key}`;
    switch (key) {
      case 'do':
      case 'then':
      case 'else':
        checkActions(value, world, inner, at);
        break;
      case 'values':
      case 'data':
      case 'bindings':
        checkFields(value, world, scope, at, component);
        break;
      case 'entity':
      case 'cond':
      case 'bound':
      case 'value':
      case 'nearestTo':
      case 'limit':
        checkExpression(value, world, scope, at);
        break;
      // Имя изменяемой привязки (ACT-4): вид связывания известен статически,
      // поэтому и несвязанное имя, и связанное `as` отвергаются здесь — как
      // несвязанный `var`, и по той же причине.
      case 'name': {
        const target = literal(value, at);
        const kind = scope.get(target);
        if (kind === undefined) fail(at, `переменная "${target}" не связана`);
        if (kind !== 'let') fail(at, `переменная "${target}" связана как "as" и неизменяема`);
        break;
      }
      case 'query':
        checkQuery(value, world, scope, at);
        break;
      case 'overrides':
        checkOverrides(value, world, scope, at, literal(args.prefab, `${here}.prefab`));
        break;
      case 'prefab': {
        const prefab = literal(value, at);
        if (prefabOf(world, prefab) === undefined) fail(at, `prefab "${prefab}" не зарегистрирован`);
        break;
      }
      case 'component':
      case 'field':
      case 'type':
      case 'as':
      case 'subStream':
        literal(value, at);
        break;
      // Аргумент вне конвенции содержимым не проверяется — предел, зафиксированный в SYS-3.
    }
  }

  // Обязательные аргументы — после обхода, а не до него: если в написанном есть
  // ошибка, называть надо её, а не первый недостающий ключ. `hasOwn`, а не
  // индексирование: то же правило разрешения имени, что у операторов (EXPR-6).
  const required = Object.hasOwn(requiredArgs, name) ? requiredArgs[name]! : [];
  for (const key of required) {
    if (args[key] === undefined) fail(here, `не задан обязательный аргумент "${key}"`);
  }
}

/** Карта «поле → выражение». Если известен компонент, поля сверяются с его схемой. */
function checkFields(
  node: unknown,
  world: WorldState,
  scope: Scope,
  path: string,
  component: string | undefined,
): void {
  const schema = component === undefined ? undefined : componentSchema(world, component);
  for (const [field, expr] of Object.entries(asMap(node, path))) {
    if (schema !== undefined && schema.fields[field] === undefined) {
      fail(`${path}.${field}`, `у компонента "${component}" нет поля "${field}"`);
    }
    checkExpression(expr, world, scope, `${path}.${field}`);
  }
}

function checkOverrides(
  node: unknown,
  world: WorldState,
  scope: Scope,
  path: string,
  prefabName: string,
): void {
  const prefab = prefabOf(world, prefabName);
  for (const [component, fields] of Object.entries(asMap(node, path))) {
    // CMD-6: переопределять можно только то, что prefab уже содержит.
    if (prefab !== undefined && !Object.hasOwn(prefab.components, component)) {
      fail(`${path}.${component}`, `prefab "${prefabName}" не содержит компонент "${component}"`);
    }
    checkFields(fields, world, scope, `${path}.${component}`, component);
  }
}

function checkQuery(node: unknown, world: WorldState, scope: Scope, path: string): void {
  const spec = asMap(node, path);
  for (const key of ['all', 'any', 'not'] as const) {
    const names = spec[key];
    if (names === undefined) continue;
    if (!Array.isArray(names)) fail(`${path}.${key}`, 'ожидался список имён компонентов');
    names.forEach((name, i) => {
      const component = literal(name, `${path}.${key}[${i}]`);
      if (componentSchema(world, component) === undefined) {
        fail(`${path}.${key}[${i}]`, `компонент "${component}" не зарегистрирован`);
      }
    });
  }
  if (spec.withTag !== undefined) literal(spec.withTag, `${path}.withTag`);
  if (spec.withinRadius !== undefined) {
    const within = asMap(spec.withinRadius, `${path}.withinRadius`);
    checkExpression(within.center, world, scope, `${path}.withinRadius.center`);
    checkExpression(within.radius, world, scope, `${path}.withinRadius.radius`);
  }
}

/**
 * Форма применения оператора берётся из его сигнатуры в `expr.ts` (EXPR-8) —
 * там же, где реализация: второй таблицы арности и литеральных позиций рядом с
 * валидатором нет по той же причине, по какой её нет у действий, — она
 * разошлась бы с оригиналом при первой же правке.
 *
 * Именами проверяемое (переменная связана, компонент и поле существуют) остаётся
 * здесь: это уже не форма узла, а сверка с зарегистрированным миром (SYS-3).
 */
function checkExpression(node: unknown, world: WorldState, scope: Scope, path: string): void {
  if (typeof node === 'number' || typeof node === 'boolean') return;
  if (typeof node === 'string') {
    fail(path, 'ожидалось выражение: строка допустима только в позиции имени');
  }
  const [op, raw] = onlyKey(node, path, 'выражение');
  const signature = signatureOf(op);
  if (signature === undefined) fail(path, `неизвестный оператор "${op}"`);
  const args = (Array.isArray(raw) ? raw : [raw]) as readonly Expression[];
  const at = `${path}.${op}`;

  // Путь до узла — `at`, как у соседних проверок этой функции: сегмент с именем
  // оператора отличает узел от того, что стоит на его месте.
  const wrongArity = arityError(op, signature, args.length);
  if (wrongArity !== undefined) fail(at, wrongArity);

  // Литеральные позиции — только имена; в остальных позициях строка отвергается
  // рекурсивным вызовом ниже. Позиция за концом списка не проверяется: она
  // бывает только у оператора с необязательным хвостом (`mask` у raycast,
  // EXPR-8), а её отсутствие уже разрешено арностью.
  for (const i of signature.literals) {
    if (i < args.length) literal(args[i], `${at}[${i}]`);
  }

  // Область определения целого литерала (SYS-3): на сегодняшнем составе это
  // только номер бита `bitTest`. Вычисляемый аргумент в той же позиции остаётся
  // ошибкой времени вычисления (SYS-9) — до тика он неизвестен.
  for (const [position, lo, hi] of signature.ranges) {
    const value = args[position];
    if (typeof value === 'number' && (!Number.isInteger(value) || value < lo || value > hi)) {
      fail(`${at}[${position}]`, `ожидалось целое ${lo}..${hi}, получено ${value}`);
    }
  }

  switch (op) {
    case 'var': {
      const name = args[0] as string;
      if (!scope.has(name)) fail(at, `переменная "${name}" не связана`);
      break;
    }
    case 'getComponent':
    case 'hasComponent': {
      const component = args[1] as string;
      const schema = componentSchema(world, component);
      if (schema === undefined) fail(`${at}[1]`, `компонент "${component}" не зарегистрирован`);
      if (op === 'getComponent') {
        const field = args[2] as string;
        if (schema.fields[field] === undefined) fail(`${at}[2]`, `у компонента "${component}" нет поля "${field}"`);
      }
      break;
    }
    // `eventField`: существование поля не проверяется — реестра типов событий и
    // их полей в ядре нет, состав данных задаёт эмитент (EXPR-2).
    default:
      break;
  }

  args.forEach((arg, i) => {
    if (signature.literals.includes(i)) return;
    checkExpression(arg, world, scope, `${at}[${i}]`);
  });
}
