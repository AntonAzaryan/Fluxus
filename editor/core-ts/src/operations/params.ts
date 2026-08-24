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
import { OperationError, type AuthoringOperation, type OperationParams, type OperationParamSpec } from './types.js';

export function checkParams(operation: AuthoringOperation, params: OperationParams): void {
  for (const name of Object.keys(params)) {
    // Собственные ключи схемы, а не цепочка прототипов: `'toString' in …`
    // истинно для любого объекта, и опечатка с именем из Object.prototype
    // прошла бы молча — вопреки правилу «лишний параметр — отказ».
    if (!Object.hasOwn(operation.params, name)) {
      throw new OperationError(operation.id, `неизвестный параметр "${name}"`, { param: name });
    }
  }
  for (const name of Object.keys(operation.params)) {
    const spec = operation.params[name]!;
    const value = params[name];
    if (value === undefined) {
      if (spec.optional === true) continue;
      throw new OperationError(operation.id, `параметр "${name}" обязателен`, { param: name });
    }
    checkValue(operation.id, name, spec, value);
  }
}

function checkValue(operationId: string, name: string, spec: OperationParamSpec, value: JsonValue): void {
  const fail = (expected: string): never => {
    throw new OperationError(operationId, `параметр "${name}": ожидалось ${expected}`, {
      param: name,
      received: value,
    });
  };
  switch (spec.type) {
    case 'document':
      if (typeof value !== 'string' || value === '') fail('непустая строка — идентификатор документа');
      return;
    case 'descriptor':
      if (typeof value !== 'string' || value === '') fail('непустая строка — сессионный дескриптор');
      return;
    case 'path':
      if (!isJsonArray(value)) fail('список шагов пути');
      else {
        for (const step of value) {
          if (typeof step !== 'string' && !Number.isInteger(step)) fail('шаг пути — имя поля или индекс');
        }
      }
      return;
    case 'string':
      if (typeof value !== 'string') fail('строка');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('конечное число');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail('логическое значение');
      return;
    case 'json':
      return;
  }
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
