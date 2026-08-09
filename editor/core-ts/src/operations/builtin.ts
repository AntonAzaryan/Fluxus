/**
 * Базовые операции над документом. Их семь, и все они — про структуру JSON:
 * записать значение по пути, убрать значение по пути, переименовать ключ
 * объекта, дописать запись в отслеживаемый список, убрать запись, править и
 * убирать значения внутри записи.
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
import { formatPath, isJsonObject, renameKeyInObject } from '../document/json.js';
import { readDescriptor, readDocumentId, readJson, readPath, readString } from './params.js';
import type { OperationRegistry } from './registry.js';
import { OperationError, type AuthoringOperation, type OperationParamSpec } from './types.js';

const DOCUMENT: OperationParamSpec = { type: 'document', descriptionKey: 'operation.param.document' };
const PATH: OperationParamSpec = { type: 'path', descriptionKey: 'operation.param.path' };
const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'operation.param.list' };
const RECORD: OperationParamSpec = { type: 'descriptor', descriptionKey: 'operation.param.record' };
const VALUE: OperationParamSpec = { type: 'json', descriptionKey: 'operation.param.value' };
const ITEM: OperationParamSpec = { type: 'json', descriptionKey: 'operation.param.item' };
const KEY_FROM: OperationParamSpec = { type: 'string', descriptionKey: 'operation.param.from' };
const KEY_TO: OperationParamSpec = { type: 'string', descriptionKey: 'operation.param.to' };

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

/**
 * Переименование ключа объекта **на прежней позиции**.
 *
 * Отдельная операция, а не пара «убрать старый ключ — записать новый», из-за
 * позиции. Ключи документов редактора не сортируются намеренно
 * (`project/canonical.ts`: сортировка дала бы дифф на весь файл вместо «только
 * связанные строки», ED-21), поэтому запись, снятая и дописанная заново,
 * уехала бы в конец объекта — и переименование одного юнита читалось бы в
 * истории версий как два блока правок вместо одного.
 *
 * Операция структурная, а не доменная: «переименовать prefab вместе с записью
 * манифеста» — вклад поверх неё (ED-19), а не имя из этого набора (ED-25).
 * Пишет она одним `setValue` в тот же объект, то есть поверхность сессии не
 * расширяет, а обратимость получает даром: история хранит прежний объект
 * целиком, и отмена возвращает и имя ключа, и его место (ED-29).
 *
 * Путь ведёт к объекту-носителю, а не к самому ключу: место, которого после
 * правки не станет, адресом быть не может. Отслеживаемые списки для этого пути
 * закрыты тем же запретом, что и для `document.setValue`, — записи списка
 * адресуются дескриптором.
 */
export const renameKeyOperation: AuthoringOperation = {
  id: 'document.renameKey',
  descriptionKey: 'operation.document.renameKey',
  params: { document: DOCUMENT, path: PATH, from: KEY_FROM, to: KEY_TO },
  apply(ctx, params) {
    const documentId = readDocumentId(params, 'document');
    const path = readPath(params, 'path');
    const from = readString(params, 'from');
    const to = readString(params, 'to');
    const node = ctx.readAt(documentId, path);
    if (!isJsonObject(node)) {
      throw new OperationError(
        renameKeyOperation.id,
        `${formatPath(path)}: ключи есть у объекта, а по этому пути объекта нет`,
        { param: 'path', received: [...path] },
      );
    }
    // Проверки — до единственной записи, а не по ходу: отказ обязан оставить
    // документ нетронутым, и «половина переименования» состоянием не бывает.
    if (!Object.hasOwn(node, from)) {
      throw new OperationError(renameKeyOperation.id, `${formatPath(path)}: ключа "${from}" здесь нет`, {
        param: 'from',
        received: from,
      });
    }
    // Совпадение имён сюда же и попадает: «переименовать в себя» — это занятый
    // ключ, и отказ говорит о нём то же самое, что о любом другом занятом.
    // Молча ничего не делать было бы хуже: автор, промахнувшийся мимо второго
    // ключа, не узнал бы, что правки не произошло.
    if (Object.hasOwn(node, to)) {
      throw new OperationError(renameKeyOperation.id, `${formatPath(path)}: ключ "${to}" уже занят`, {
        param: 'to',
        received: to,
      });
    }
    ctx.setValue(documentId, path, renameKeyInObject(node, from, to));
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
  renameKeyOperation,
  appendRecordOperation,
  removeRecordOperation,
  setRecordValueOperation,
  removeRecordValueOperation,
]);

export function registerBuiltinOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of BUILTIN_OPERATIONS) registry.register(operation);
  return registry;
}
