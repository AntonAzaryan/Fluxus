/**
 * JSON-система (SYS-1) и её валидация на регистрации (SYS-3).
 *
 * Для scheduler'а неотличима от нативной: тот же интерфейс `System`, то же
 * чтение через контекст и запись через Command Buffer (SYS-4, SYS-6). Именно
 * это делает `override` (SYS-7) безопасным — переписывание системы в код не
 * меняет ничего вокруг.
 */
import { execute, actionNames, type Action } from './actions.js';
import { operators, type Expression } from './expr.js';
import { componentSchema, prefabOf } from './ecs/world.js';
import type { System, SystemContext, WorldState } from './types.js';

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
 * Разворачивает `query` в одно действие `forEach`. Отдельного механизма
 * итерации у системы нет намеренно: два цикла с разной семантикой области
 * видимости — лишний способ ошибиться.
 */
function bodyOf(def: SystemDef): readonly Action[] {
  if (!Array.isArray(def.do)) throw new Error(`система "${def.name}": "do" — список действий`);
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
    execute(this.body, ctx);
  }
}

// ------------------------------------------------------------- валидация

/**
 * Проверяет дерево до старта матча (SYS-3). `bound` — имена, считающиеся
 * связанными снаружи: сейчас пусто, параметр под входные параметры систем
 * (этап 9).
 */
export function validateSystem(def: SystemDef, world: WorldState, bound: readonly string[] = []): void {
  checkActions(bodyOf(def), world, new Set(bound), `система "${def.name}"`);
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

function checkActions(list: unknown, world: WorldState, scope: ReadonlySet<string>, path: string): void {
  if (!Array.isArray(list)) fail(path, 'ожидался список действий');
  list.forEach((node, i) => checkAction(node, world, scope, `${path}[${i}]`));
}

/**
 * Обход опирается на конвенцию имён аргументов, единую для всего Action DSL
 * (SYS-3), а не на вторую таблицу рядом с таблицей действий: таблица-дубль
 * рассинхронизировалась бы с оригиналом при первом же новом действии.
 */
function checkAction(node: unknown, world: WorldState, scope: ReadonlySet<string>, path: string): void {
  const [name, rawArgs] = onlyKey(node, path, 'действие');
  if (!actionNames.includes(name)) fail(path, `неизвестное действие "${name}"`);
  const here = `${path}.${name}`;
  const args = asMap(rawArgs, here);

  // Имена, введённые этим действием, видны только его телу; `bindings` при
  // этом вычисляются снаружи (параллельное связывание, см. ACT-1).
  const inner = new Set(scope);
  if (args['as'] !== undefined) inner.add(literal(args['as'], `${here}.as`));
  if (args['bindings'] !== undefined) {
    for (const key of Object.keys(asMap(args['bindings'], `${here}.bindings`))) inner.add(key);
  }

  const component = args['component'] === undefined ? undefined : literal(args['component'], `${here}.component`);
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
        checkExpression(value, world, scope, at);
        break;
      case 'query':
        checkQuery(value, world, scope, at);
        break;
      case 'overrides':
        checkOverrides(value, world, scope, at, literal(args['prefab'], `${here}.prefab`));
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
}

/** Карта «поле → выражение». Если известен компонент, поля сверяются с его схемой. */
function checkFields(
  node: unknown,
  world: WorldState,
  scope: ReadonlySet<string>,
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
  scope: ReadonlySet<string>,
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

function checkQuery(node: unknown, world: WorldState, scope: ReadonlySet<string>, path: string): void {
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
  if (spec['withTag'] !== undefined) literal(spec['withTag'], `${path}.withTag`);
  if (spec['withinRadius'] !== undefined) {
    const within = asMap(spec['withinRadius'], `${path}.withinRadius`);
    checkExpression(within['center'], world, scope, `${path}.withinRadius.center`);
    checkExpression(within['radius'], world, scope, `${path}.withinRadius.radius`);
  }
}

/**
 * Строковые литералы принимают только `var`, `getComponent` и `hasComponent`;
 * у всех остальных операторов аргументы — выражения, поэтому обход общий.
 */
function checkExpression(node: unknown, world: WorldState, scope: ReadonlySet<string>, path: string): void {
  if (typeof node === 'number' || typeof node === 'boolean') return;
  const [op, raw] = onlyKey(node, path, 'выражение');
  if (!operators.includes(op)) fail(path, `неизвестный оператор "${op}"`);
  const args = (Array.isArray(raw) ? raw : [raw]) as readonly Expression[];
  const at = `${path}.${op}`;

  if (op === 'var') {
    const name = literal(args[0], `${at}[0]`);
    if (!scope.has(name)) fail(at, `переменная "${name}" не связана`);
    return;
  }
  if (op === 'getComponent' || op === 'hasComponent') {
    checkExpression(args[0], world, scope, `${at}[0]`);
    const component = literal(args[1], `${at}[1]`);
    const schema = componentSchema(world, component);
    if (schema === undefined) fail(`${at}[1]`, `компонент "${component}" не зарегистрирован`);
    if (op === 'getComponent') {
      const field = literal(args[2], `${at}[2]`);
      if (schema.fields[field] === undefined) fail(`${at}[2]`, `у компонента "${component}" нет поля "${field}"`);
    }
    return;
  }
  args.forEach((arg, i) => checkExpression(arg, world, scope, `${at}[${i}]`));
}
