/**
 * Разбор недоверенного JSON определений (ABIL-10): чтение значения известной
 * формы либо ошибка загрузки, называющая место.
 *
 * Отдельным модулем — потому что читают его и компиляция определений, и разбор
 * биндингов сцены, а формулировки отказов обязаны быть одни: автор правит один
 * документ и не должен читать два разных текста про одну и ту же опечатку.
 *
 * `Array.isArray` здесь не применяется к уже объявленному типу: на объявленном
 * он сужает к `any[]`, то есть отключает типы ровно там, где проверяются
 * недоверенные данные (тот же приём и та же причина, что у `isActionList` в
 * `dsl/evaluatedSystem.ts`).
 */
import { validateActions, validateExpression } from '../../dsl/evaluatedSystem.js';
import type { Action } from '../../dsl/actions.js';
import type { Expression } from '../../dsl/expr.js';
import type { WorldState } from '../../types.js';

const NO_ACTIONS: readonly Action[] = [];

/**
 * Номер бита МАСКИ КНОПОК: значимые биты 0..15 (TICK-2). Ширину задаёт то
 * требование и только оно — «любой потребитель маски SHALL исходить из той же
 * ширины», — а собственная ширина в геймплейной системе объявлена там же
 * расхождением с нормой. Индексы 0..31 оператора `bitTest` (EXPR-2) вторым
 * определением ширины не являются: он общий над произвольной `i32`-маской, и
 * его же область определения носит маска лока (LOC-7), которая через эту
 * проверку не проходит — она читается целым числом.
 */
const BIT_MAX = 15;

export function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

export function asObject(node: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) fail(path, 'ожидался объект');
  return node as Readonly<Record<string, unknown>>;
}

/** Список недоверенной длины; элементы читаются по одному теми же функциями. */
export function asList(node: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(node)) fail(path, 'ожидался список');
  return node as readonly unknown[];
}

export function literalName(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'ожидалось непустое имя строкой');
  return value;
}

/**
 * Номер бита маски кнопок из недоверенного документа (ABIL-3): бит запуска,
 * подтверждения и отмены. Бит выше пятнадцатого — отказ на загрузке, а не
 * молча принятая кнопка: до провода он не доедет (маска — u16, TICK-2), и
 * способность оказалась бы ненажимаемой без единого сообщения.
 */
export function bitOf(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > BIT_MAX) {
    fail(
      path,
      `ожидался номер бита маски кнопок — целое 0..${BIT_MAX} (ABIL-3, ширина маски u16 по TICK-2), ` +
        `получено ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Ключ закрытого набора: имя из словаря либо ошибка, перечисляющая словарь. */
export function keyOf(table: Readonly<Record<string, number>>, value: unknown, path: string): number {
  const name = literalName(value, path);
  if (!Object.hasOwn(table, name)) {
    fail(path, `неизвестное значение "${name}"; допустимы: ${Object.keys(table).sort().join(', ')}`);
  }
  return table[name]!;
}

/**
 * Список действий с предсвязанными именами: проверяется тем же обходом, что
 * валидирует JSON-систему (SYS-3, ABIL-11). Отсутствие блока — пустой список.
 */
export function actionsOf(
  node: unknown,
  world: WorldState,
  bound: readonly string[],
  path: string,
): readonly Action[] {
  if (node === undefined) return NO_ACTIONS;
  validateActions(node, world, bound, path);
  return node as readonly Action[];
}

/** Выражение определения — тем же обходом и с теми же предсвязанными именами. */
export function expressionOf(
  node: unknown,
  world: WorldState,
  bound: readonly string[],
  path: string,
): Expression | undefined {
  if (node === undefined) return undefined;
  validateExpression(node, world, bound, path);
  return node as Expression;
}
