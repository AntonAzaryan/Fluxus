/**
 * Базовые операции над документом. Их шесть, и все они — про структуру JSON:
 * записать значение по пути, убрать значение по пути, дописать запись в
 * отслеживаемый список, убрать запись, править и убирать значения внутри
 * записи.
 *
 * Доменных операций («поставить юнита», «поднять уровень клетки») здесь нет и
 * не будет: каркас не содержит доменных имён редактируемого (ED-25), а какой
 * компонент и какие поля несут позицию, редактор берёт из настройки проекта, а
 * не из зашитого имени (ED-16). Расстановка и кисти регистрируют свои операции
 * поверх этих же примитивов — тем же реестром и с тем же откатом.
 *
 * Чего в этом наборе нет намеренно — перестановки записей. Порядок записей
 * расстановки нормативен: он задаёт выданные ID, а через плоскую форму мира —
 * хеш `worldInit` (SER-8, ED-16). Отсутствие операции перестановки — не пробел,
 * а способ сделать «перестановка MUST NOT быть побочным эффектом» проверяемым:
 * переставить нечем.
 */
import { readDescriptor, readDocumentId, readJson, readPath } from './params.js';
import type { OperationRegistry } from './registry.js';
import type { AuthoringOperation, OperationParamSpec } from './types.js';

const DOCUMENT: OperationParamSpec = { type: 'document', descriptionKey: 'operation.param.document' };
const PATH: OperationParamSpec = { type: 'path', descriptionKey: 'operation.param.path' };
const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'operation.param.list' };
const RECORD: OperationParamSpec = { type: 'descriptor', descriptionKey: 'operation.param.record' };
const VALUE: OperationParamSpec = { type: 'json', descriptionKey: 'operation.param.value' };
const ITEM: OperationParamSpec = { type: 'json', descriptionKey: 'operation.param.item' };

/** Правка одного места документа — то, чем пишет инспектор (ED-24). */
export const setValueOperation: AuthoringOperation = {
  id: 'document.setValue',
  descriptionKey: 'operation.document.setValue',
  params: { document: DOCUMENT, path: PATH, value: VALUE },
  apply(ctx, params) {
    ctx.setValue(readDocumentId(params, 'document'), readPath(params, 'path'), readJson(params, 'value'));
    return undefined;
  },
};

/** Снятие значения: поле исчезает, а не получает `null` — это разные документы. */
export const removeValueOperation: AuthoringOperation = {
  id: 'document.removeValue',
  descriptionKey: 'operation.document.removeValue',
  params: { document: DOCUMENT, path: PATH },
  apply(ctx, params) {
    ctx.removeValue(readDocumentId(params, 'document'), readPath(params, 'path'));
    return undefined;
  },
};

/** Дописывает запись в конец списка и отдаёт её сессионный дескриптор (SER-8). */
export const appendRecordOperation: AuthoringOperation = {
  id: 'document.list.append',
  descriptionKey: 'operation.document.list.append',
  params: { document: DOCUMENT, list: LIST, item: ITEM },
  apply(ctx, params) {
    return ctx.appendRecord(readDocumentId(params, 'document'), readPath(params, 'list'), readJson(params, 'item'));
  },
};

export const removeRecordOperation: AuthoringOperation = {
  id: 'document.list.remove',
  descriptionKey: 'operation.document.list.remove',
  params: { document: DOCUMENT, record: RECORD },
  apply(ctx, params) {
    ctx.removeRecord(readDocumentId(params, 'document'), readDescriptor(params, 'record'));
    return undefined;
  },
};

/** Правка внутри записи: путь отсчитывается от записи, адрес — дескриптор (ED-29). */
export const setRecordValueOperation: AuthoringOperation = {
  id: 'document.list.setValue',
  descriptionKey: 'operation.document.list.setValue',
  params: { document: DOCUMENT, record: RECORD, path: PATH, value: VALUE },
  apply(ctx, params) {
    ctx.setRecordValue(
      readDocumentId(params, 'document'),
      readDescriptor(params, 'record'),
      readPath(params, 'path'),
      readJson(params, 'value'),
    );
    return undefined;
  },
};

export const removeRecordValueOperation: AuthoringOperation = {
  id: 'document.list.removeValue',
  descriptionKey: 'operation.document.list.removeValue',
  params: { document: DOCUMENT, record: RECORD, path: PATH },
  apply(ctx, params) {
    ctx.removeRecordValue(
      readDocumentId(params, 'document'),
      readDescriptor(params, 'record'),
      readPath(params, 'path'),
    );
    return undefined;
  },
};

export const BUILTIN_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  setValueOperation,
  removeValueOperation,
  appendRecordOperation,
  removeRecordOperation,
  setRecordValueOperation,
  removeRecordValueOperation,
]);

export function registerBuiltinOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of BUILTIN_OPERATIONS) registry.register(operation);
  return registry;
}
