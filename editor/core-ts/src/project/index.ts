/**
 * Проект как то, что лежит в дереве контента: открытие документов через хост
 * среды (ED-12) и каноническое сохранение (ED-21). Формат байтов — сериализатор
 * ядра; своего у редактора нет (ED-3).
 *
 * Каркасная часть перечисляется именами, модуль вклада реэкспортируется целиком:
 * его имена доменные, и перечислить их здесь значило бы внести доменные имена в
 * каркас (ED-25, третий абзац). Тот же приём — в бареле валидации.
 */
export { canonicalizeDocument, decodeDocument, encodeDocument, isCanonicalDocument } from './canonical.js';

export { openDocumentFromHost, readDocument } from './documents.js';
export type { OpenFromHostInput, ReadDocument } from './documents.js';

export { issueKey } from './consistency.js';
export type { ConsistencyIssue, ConsistencyRule, DocumentGroup, ProjectView } from './consistency.js';

export { GROUP_WRITE_RULE_ID, saveDocuments } from './save.js';
export type { SaveIssue, SaveRequest, SaveResult } from './save.js';

export { loadProjectBundles } from './locales.js';
export type { ProjectBundleFailure, ProjectBundlesResult } from './locales.js';

export * from './pairing.js';
