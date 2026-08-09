/**
 * Модель документа и сессия проекта. Барель существует, чтобы публичная
 * поверхность пакета переэкспортировала слой одной строкой, а не перечисляла
 * файлы: состав файлов — дело слоя, а не его потребителей.
 */
export type { JsonArray, JsonObject, JsonPath, JsonPrimitive, JsonValue } from './json.js';
export {
  formatPath,
  getAtPath,
  isJsonArray,
  isJsonObject,
  pathKey,
  pathsEqual,
  pathStartsWith,
  // Чистая функция, а не запись: она возвращает НОВЫЙ объект и в документ
  // ничего не пишет — писать по-прежнему умеет только поверхность операции
  // (ED-29). Наружу она нужна доменной операции, которой переименование ключа
  // достаётся половиной действия над парой документов (ED-19): своя копия
  // сохранения позиции ключа рядом с `document.renameKey` разошлась бы с ним
  // молча, а позиция ключа — это дифф на один блок вместо двух (ED-21).
  renameKeyInObject,
} from './json.js';
export { DESCRIPTOR_SCOPE } from './descriptors.js';
export type { DescriptorId, DescriptorLocation, DescriptorTable } from './descriptors.js';
export type { DocumentId, DocumentKind, DocumentPathRef, EditorDocument, OpenDocumentInput } from './types.js';
export { DEFAULT_HISTORY_DEPTH } from './history.js';
export type { HistoryEntryView, HistorySnapshot } from './history.js';
export { createEditorSession } from './session.js';
export type {
  AuthoringSuspension,
  EditorSession,
  EditorSessionOptions,
  OperationOutcome,
  OperationTransaction,
  SessionEvent,
  SessionEventKind,
} from './session.js';
