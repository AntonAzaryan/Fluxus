/**
 * Проверка и чтение параметров операции по её схеме.
 *
 * Проверка живёт здесь, а не в каждой операции, по той же причине, по какой
 * откат один на все: схема параметров — единственное описание того, что
 * операция принимает (ED-30), и вторая проверка внутри `apply` разошлась бы с
 * ней ровно тогда, когда схему поправили, а код — нет.
 *
 * Лишний параметр — отказ, а не «не заметили». Вызов без интерфейса (ED-29)
 * приходит из чужих рук, и опечатка в имени параметра обязана быть видна на
 * вызове, а не проявиться документом, в котором ничего не изменилось.
 */
import { isJsonArray, type JsonPath, type JsonValue } from '../document/json.js';
import type { DocumentId } from '../document/types.js';
import {
  OperationError,
  type AuthoringOperation,
  type OperationParams,
  type OperationParamSpec,
  type OperationParamType,
} from './types.js';

export function checkParams(operation: AuthoringOperation, params: OperationParams): void {
  for (const name of Object.keys(params)) {
    // Собственные ключи схемы, а не цепочка прототипов: `'toString' in …`
    // истинно для любого объекта, и опечатка с именем из Object.prototype
    // прошла бы молча — вопреки правилу «лишний параметр — отказ».
    if (!Object.hasOwn(operation.params, name)) {
      throw new OperationError(operation.id, `неизвестный параметр "${name}"`, { param: name });
    }
  }
  for (const [name, spec] of Object.entries(operation.params)) {
    const value = params[name];
    if (value === undefined) {
      if (spec.optional === true) continue;
      throw new OperationError(operation.id, `параметр "${name}" обязателен`, { param: name });
    }
    checkValue(operation.id, name, spec, value);
  }
}

/**
 * Проверка значения по виду параметра: `undefined` — подошло, иначе текст
 * ожидания для отказа.
 */
type ParamCheck = (value: JsonValue) => string | undefined;

function filledString(value: JsonValue): boolean {
  return typeof value === 'string' && value !== '';
}

function checkPath(value: JsonValue): string | undefined {
  if (!isJsonArray(value)) return 'список шагов пути';
  for (const step of value) {
    if (typeof step !== 'string' && !Number.isInteger(step)) return 'шаг пути — имя поля или индекс';
  }
  return undefined;
}

/**
 * Таблица «вид параметра → проверка», а не цепочка ветвей: вид — закрытый
 * перечень схемы (`OperationParamType`), и `Record` по нему не даёт завести
 * новый вид, забыв о проверке.
 */
const PARAM_CHECKS: Readonly<Record<OperationParamType, ParamCheck>> = {
  document: (value) => (filledString(value) ? undefined : 'непустая строка — идентификатор документа'),
  descriptor: (value) => (filledString(value) ? undefined : 'непустая строка — сессионный дескриптор'),
  path: checkPath,
  string: (value) => (typeof value === 'string' ? undefined : 'строка'),
  number: (value) => (typeof value === 'number' && Number.isFinite(value) ? undefined : 'конечное число'),
  boolean: (value) => (typeof value === 'boolean' ? undefined : 'логическое значение'),
  json: () => undefined,
};

function checkValue(operationId: string, name: string, spec: OperationParamSpec, value: JsonValue): void {
  const expected = PARAM_CHECKS[spec.type](value);
  if (expected === undefined) return;
  throw new OperationError(operationId, `параметр "${name}": ожидалось ${expected}`, {
    param: name,
    received: value,
  });
}

/*
 * Читатели ниже — приведение типа, а не вторая проверка: `checkParams` уже
 * отработал к моменту вызова `apply`, и повторная проверка была бы тем самым
 * вторым описанием параметров, от которого этот модуль и избавляет.
 */

export function readDocumentId(params: OperationParams, name: string): DocumentId {
  return params[name] as DocumentId;
}

/** Отсутствующий необязательный путь — корень документа, то есть пустой список шагов. */
export function readPath(params: OperationParams, name: string): JsonPath {
  return (params[name] ?? []) as JsonPath;
}

export function readDescriptor(params: OperationParams, name: string): string {
  return params[name] as string;
}

export function readString(params: OperationParams, name: string): string {
  return params[name] as string;
}

export function readJson(params: OperationParams, name: string): JsonValue {
  return params[name] ?? null;
}
