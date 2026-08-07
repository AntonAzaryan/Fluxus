/**
 * Модель документа и сессия проекта. Барель существует, чтобы публичная
 * поверхность пакета переэкспортировала слой одной строкой, а не перечисляла
 * файлы: состав файлов — дело слоя, а не его потребителей.
 */
export type { JsonArray, JsonObject, JsonPath, JsonPrimitive, JsonValue } from './json.js';
export { formatPath, getAtPath, isJsonArray, isJsonObject, pathKey, pathsEqual, pathStartsWith } from './json.js';
export { DESCRIPTOR_SCOPE } from './descriptors.js';
export type { DescriptorId, DescriptorLocation, DescriptorTable } from './descriptors.js';
export type { DocumentId, DocumentKind, DocumentPathRef, EditorDocument, OpenDocumentInput } from './types.js';
export { DEFAULT_HISTORY_DEPTH } from './history.js';
export type { HistoryEntryView, HistorySnapshot } from './history.js';
export { createEditorSession } from './session.js';
export type {
  EditorSession,
  EditorSessionOptions,
  OperationOutcome,
  OperationTransaction,
  SessionEvent,
  SessionEventKind,
} from './session.js';
