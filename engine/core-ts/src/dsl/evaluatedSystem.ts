/**
 * JSON-система (SYS-1) и её валидация на регистрации (SYS-3).
 *
 * Для scheduler'а неотличима от системы на TS: тот же интерфейс `System`, то же
 * чтение через контекст и запись через Command Buffer (SYS-4, SYS-6). Именно
 * это делает `override` (SYS-7) безопасным — переписывание системы в код не
 * меняет ничего вокруг.
 *
 * TimeScale (TIME-5): учитывает или игнорирует — решает КАЖДАЯ система-данные
 * сама, своим текстом: собственного времени у исполнителя нет, а эффективный
 * темп сущности читается из мира обычным выражением там, где он нужен автору
 * (TIME-4). Ответ здесь того же рода, что у твинов (TWEEN-7): у механизма
 * единого решения нет, оно в данных.
 */
import { execute, actionNames, requiredArgs, systemError, type Action } from './actions.js';
import { arityError, signatureOf, type Expression, type OpSignature } from './expr.js';
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
  validateActions(bodyOf(def), world, bound, `система "${def.name}"`);
}

/** Область видимости из имён, связанных снаружи: внешнее имя неизменяемо (не `let`). */
function outerScope(bound: readonly string[]): Scope {
  return new Map<string, BindingKind>(bound.map((name) => [name, 'as']));
}

/**
 * Проверка списка действий с предсвязанными именами — тот же обход, что
 * валидирует JSON-систему (SYS-3). Наружу вынесена ради платформы способностей
 * (ABIL-10, ABIL-11): её эффекты и списки фаз проверяются ЭТИМ кодом, а не
 * вторым набором правил, иначе опечатка в имени действия дожила бы до первого
 * срабатывания ветки.
 */
export function validateActions(
  list: unknown,
  world: WorldState,
  bound: readonly string[],
  path: string,
): void {
  checkActions(list, world, outerScope(bound), path);
}

/**
 * Проверка одиночного выражения с предсвязанными именами. Списком действий она
 * не выражается: числа определения способности (`cooldownTicks`, `range`,
 * `durationTicks`) стоят вне всякого действия, а проверять их обязан тот же
 * обход, что и выражения внутри действий (SYS-3).
 */
export function validateExpression(
  node: unknown,
  world: WorldState,
  bound: readonly string[],
  path: string,
): void {
  checkExpression(node, world, outerScope(bound), path);
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
  const inner = innerScope(scope, args, here);

  const component = args.component === undefined ? undefined : literal(args.component, `${here}.component`);
  if (component !== undefined && componentSchema(world, component) === undefined) {
    fail(`${here}.component`, `компонент "${component}" не зарегистрирован`);
  }

  // Окружение собирается один раз на действие, а не на каждый его аргумент.
  const argScope: ActionArgScope = { world, scope, inner, args, component, here };
  for (const [key, value] of Object.entries(args)) {
    checkActionArg(key, value, argScope);
  }

  // Обязательные аргументы — после обхода, а не до него: если в написанном есть
  // ошибка, называть надо её, а не первый недостающий ключ. `hasOwn`, а не
  // индексирование: то же правило разрешения имени, что у операторов (EXPR-6).
  const required = Object.hasOwn(requiredArgs, name) ? requiredArgs[name]! : [];
  for (const key of required) {
    if (args[key] === undefined) fail(here, `не задан обязательный аргумент "${key}"`);
  }
}

/**
 * Имена, введённые действием, видны только его телу; `bindings` при этом
 * вычисляются снаружи (параллельное связывание, см. ACT-1). Вид связывания
 * запоминается вместе с именем — по нему решается `set` (ACT-4).
 */
function innerScope(scope: Scope, args: Readonly<Record<string, unknown>>, here: string): Scope {
  const inner = new Map(scope);
  if (args.as !== undefined) inner.set(literal(args.as, `${here}.as`), 'as');
  if (args.bindings !== undefined) {
    for (const key of Object.keys(asMap(args.bindings, `${here}.bindings`))) inner.set(key, 'let');
  }
  return inner;
}

/**
 * Окружение разбора одного аргумента действия: обе области имён (внешняя — для
 * выражений, внутренняя — для тела), сам список аргументов и путь до узла.
 * Записью, а не восемью позиционными аргументами: вызов — один на аргумент
 * действия, на регистрации системы, вне тика.
 */
interface ActionArgScope {
  readonly world: WorldState;
  readonly scope: Scope;
  readonly inner: Scope;
  readonly args: Readonly<Record<string, unknown>>;
  readonly component: string | undefined;
  readonly here: string;
}

/** Один аргумент действия по конвенции имён Action DSL (SYS-3). */
function checkActionArg(key: string, value: unknown, ctx: ActionArgScope): void {
  const { world, scope, inner, args, component, here } = ctx;
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
    case 'at':
    case 'radius':
    case 'def':
    case 'from':
    case 'to':
    case 'duration':
    case 'easing':
    case 'ignoreTimeScale':
    case 'id':
      // Аргументы-выражения: шесть общих позиций плюс `at`/`radius` у
      // carveFloor, числа addTween (`def`, `from`, `to`, `duration`,
      // `easing`, `ignoreTimeScale`) и `id` модификаторов. Исполнитель
      // вычисляет их все одним `evaluate` — значит и проверяет их этот же
      // обход (SYS-3): опечатка в редко исполняемой ветке обязана упасть на
      // регистрации, а не на первом срабатывании.
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
    // Ключ вне конвенции не читает ни одно действие таблицы (SYS-3), поэтому
    // он отвергается, а не пропускается: молча пропущенный ключ — это и
    // опечатка в имени необязательного аргумента («radiuss» вместо «radius»),
    // дожившая до середины матча значением по умолчанию, и выражение внутри
    // него, не проверенное на регистрации вовсе. Заодно правило держит саму
    // конвенцию полной: действие с аргументом под новым именем не заработает,
    // пока имя не внесено сюда и в SYS-3.
    default:
      fail(at, `аргумент "${key}" вне конвенции имён Action DSL (SYS-3)`);
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
      // Имя — из самой схемы: реестр адресует её именно им (ECS-5), и в
      // сообщении не остаётся `component`, который тип видит как необязательный.
      fail(`${path}.${field}`, `у компонента "${schema.name}" нет поля "${field}"`);
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

/** Состав спецификации запроса закрыт `ecs-foundation` QUERY-1; ключ вне него исполнителю невидим. */
const QUERY_KEYS: readonly string[] = ['all', 'any', 'not', 'withTag', 'withinRadius'];

function checkQuery(node: unknown, world: WorldState, scope: Scope, path: string): void {
  const spec = asMap(node, path);
  for (const key of Object.keys(spec)) {
    // Тот же довод, что у ключа действия вне конвенции (SYS-3): «withinRadiuss»
    // не сузил бы выборку вовсе, и узнать об этом было бы негде до матча.
    if (!QUERY_KEYS.includes(key)) fail(`${path}.${key}`, `фильтр "${key}" не входит в состав запроса (QUERY-1)`);
  }
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

  checkSignatureShape(signature, args, at);
  checkOperandNames(op, args, world, scope, at);

  args.forEach((arg, i) => {
    if (signature.literals.includes(i)) return;
    checkExpression(arg, world, scope, `${at}[${i}]`);
  });
}

/**
 * Форма аргументов по сигнатуре оператора (EXPR-8): литеральные позиции и
 * области определения целых литералов.
 */
function checkSignatureShape(signature: OpSignature, args: readonly Expression[], at: string): void {
  // Литеральные позиции — только имена; в остальных позициях строка отвергается
  // рекурсивным вызовом снаружи. Позиция за концом списка не проверяется: она
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
}

/**
 * Сверка с зарегистрированным миром: связана ли переменная, существуют ли
 * компонент и поле (SYS-3). Это уже не форма узла, поэтому и живёт отдельно от
 * проверки по сигнатуре.
 */
function checkOperandNames(
  op: string,
  args: readonly Expression[],
  world: WorldState,
  scope: Scope,
  at: string,
): void {
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
}
