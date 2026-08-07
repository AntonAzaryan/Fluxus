/**
 * Сборка результата прогона: устойчивый порядок находок и индексы по адресу.
 *
 * Порядок задаётся здесь, а не порядком исполнения правил, по той же причине,
 * по которой реестр вкладов перечисляет их отсортированно: набор находок —
 * машинный выход (ED-30), и он обязан быть одним и тем же при любой сборке
 * редактора и в любой локали. Сравнение — по кодовым точкам и по шагам пути, а
 * не `localeCompare` (ED-27).
 *
 * Шаги пути сравниваются как шаги, а не как строки: индексы 2 и 10 в списке
 * идут в этом порядке, иначе находки по записям расстановки перемешались бы
 * лексикографически, и «десятая клетка сверху» оказалась бы между первой и
 * второй.
 */
import { pathKey, pathStartsWith, type JsonPath } from '../document/index.js';
import { compareIds } from '../registry/index.js';
import type { DocumentId } from '../document/index.js';
import type { ValidationIssue, ValidationReport, ValidationSeverity } from './types.js';

const EMPTY: readonly ValidationIssue[] = Object.freeze([]);

/** Числовой шаг раньше строкового: список и объект в одном месте не сосуществуют. */
export function comparePaths(a: JsonPath, b: JsonPath): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (typeof left === 'number' && typeof right === 'number') {
      if (left !== right) return left - right;
      continue;
    }
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    const order = compareIds(left, right);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

export function compareIssues(a: ValidationIssue, b: ValidationIssue): number {
  const byDocument = compareIds(a.documentId, b.documentId);
  if (byDocument !== 0) return byDocument;
  const byPath = comparePaths(a.path, b.path);
  if (byPath !== 0) return byPath;
  const byRule = compareIds(a.ruleId, b.ruleId);
  return byRule !== 0 ? byRule : compareIds(a.reasonKey, b.reasonKey);
}

/**
 * Ключ индекса «документ + путь». Разделитель — нулевой символ: id документа
 * есть путь от корня дерева контента (ASSET-2), и любой печатный разделитель в
 * имени файла встречается, а этот — нет.
 */
const ADDRESS_SEPARATOR = '\u0000';

function addressKey(documentId: DocumentId, path: JsonPath): string {
  return `${documentId}${ADDRESS_SEPARATOR}${pathKey(path)}`;
}

/**
 * Ключ тождества находки: «то же правило о том же месте по той же причине».
 * Нужен там, где сравниваются два прогона: сохранение отличает по нему
 * расхождение, которое вносит оно само, от лежавшего на диске до него (ED-21).
 *
 * В ключ не входят `received` и `expected` — они говорят, что правило увидело
 * вокруг находки, и меняются от правки соседнего места: список известных имён в
 * ссылочном ожидании сдвигается от появления любого нового prefab'а. Считать по
 * ним тождество значило бы объявлять давнее нарушение новым всякий раз, когда
 * рядом что-то поменялось, — то есть отказывать в записи из-за состояния, к
 * которому эта запись отношения не имеет.
 */
export function issueKey(issue: ValidationIssue): string {
  const params = Object.keys(issue.reasonParams)
    .sort(compareIds)
    .map((name) => `${name}=${String(issue.reasonParams[name])}`)
    .join(',');
  return [issue.ruleId, issue.documentId, pathKey(issue.path), issue.reasonKey, params].join(ADDRESS_SEPARATOR);
}

function worst(issues: readonly ValidationIssue[]): ValidationSeverity | undefined {
  let found: ValidationSeverity | undefined;
  for (const issue of issues) {
    if (issue.severity === 'error') return 'error';
    found = issue.severity;
  }
  return found;
}

export function createReport(found: readonly ValidationIssue[]): ValidationReport {
  const issues = Object.freeze([...found].sort(compareIssues));
  const byDocument = new Map<DocumentId, ValidationIssue[]>();
  const byAddress = new Map<string, ValidationIssue[]>();
  let ok = true;
  for (const issue of issues) {
    if (issue.severity === 'error') ok = false;
    const inDocument = byDocument.get(issue.documentId);
    if (inDocument === undefined) byDocument.set(issue.documentId, [issue]);
    else inDocument.push(issue);
    const key = addressKey(issue.documentId, issue.path);
    const here = byAddress.get(key);
    if (here === undefined) byAddress.set(key, [issue]);
    else here.push(issue);
  }

  const forDocument = (documentId: DocumentId): readonly ValidationIssue[] =>
    byDocument.get(documentId) ?? EMPTY;

  const under = (documentId: DocumentId, path: JsonPath): readonly ValidationIssue[] => {
    if (path.length === 0) return forDocument(documentId);
    return forDocument(documentId).filter((issue) => pathStartsWith(issue.path, path));
  };

  return {
    issues,
    ok,
    forDocument,
    at: (documentId, path) => byAddress.get(addressKey(documentId, path)) ?? EMPTY,
    under,
    severityOf: (documentId, path) => worst(path === undefined ? forDocument(documentId) : under(documentId, path)),
  };
}
